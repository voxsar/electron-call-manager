using InTheHand.Net.Bluetooth;
using InTheHand.Net.Sockets;
using System.Text;

namespace NativeDeviceService.Services;

// ---------------------------------------------------------------------------
// HfpSession – maintains a persistent RFCOMM connection to a Bluetooth device
// using the Hands-Free Profile.  A background read loop parses unsolicited AT
// result codes (RING, +CLIP, +CIEV, NO CARRIER) and raises C# events so that
// TelephonyService can track the phone's call state in real time.
// ---------------------------------------------------------------------------

public sealed class HfpSession : IDisposable
{
	private readonly ILogger<HfpSession> _logger;

	private BluetoothClient? _client;
	private StreamReader? _reader;
	private StreamWriter? _writer;
	private CancellationTokenSource? _cts;
	private Task? _readTask;
	private readonly object _lock = new();

	// ── HFP UUIDs ──────────────────────────────────────────────────────────────────
	private static readonly Guid HfpAgUuid = new("0000111f-0000-1000-8000-00805f9b34fb"); // AG role (phone)
	private static readonly Guid HfpUuid = new("0000111e-0000-1000-8000-00805f9b34fb");  // HF role
	private static readonly Guid SppUuid = new("00001101-0000-1000-8000-00805f9b34fb");  // SPP fallback

	// ── Observable state ────────────────────────────────────────────────────
	public bool IsConnected { get; private set; }
	public CallState CurrentCallState { get; private set; } = CallState.Idle;
	public string? CurrentCallerId { get; private set; }

	/// <summary>Raised whenever the call state or caller ID changes.</summary>
	public event Action<CallState, string?>? CallStateChanged;

	// ── CIND indicator index mapping (populated during SLC init) ────────────
	private int _callIndicatorIndex = -1;      // "call"      (0/1)
	private int _callSetupIndicatorIndex = -1;  // "callsetup" (0-3)

	public HfpSession(ILogger<HfpSession> logger)
	{
		_logger = logger;
	}

	// ── Connect ─────────────────────────────────────────────────────────────

	/// <summary>
	/// Open a persistent RFCOMM connection and start the background reader.
	/// Returns true if the connection was established and SLC initialised.
	/// </summary>
	public async Task<bool> ConnectAsync(string deviceAddress)
	{
		Disconnect();

		return await Task.Run(() =>
		{
			try
			{
				var address = InTheHand.Net.BluetoothAddress.Parse(deviceAddress);

				_client = new BluetoothClient();
				// Try AG UUID first (phone's AG role), then HFP unit, then SPP.
				bool connected = TryConnect(address, HfpAgUuid)
					|| TryConnect(address, HfpUuid)
					|| TryConnect(address, SppUuid);

				if (!connected)
				{
					_logger.LogWarning("RFCOMM connection to {Addr} failed on both HFP and SPP", deviceAddress);
					CleanupConnection();
					return false;
				}

				var stream = _client.GetStream();
				_reader = new StreamReader(stream, Encoding.ASCII);
				_writer = new StreamWriter(stream, Encoding.ASCII) { AutoFlush = true };

				IsConnected = true;
				_logger.LogInformation("HFP RFCOMM connected to {Addr}", deviceAddress);

				// Start SLC initialisation (best-effort).
				InitSlc();

				// Start the background reader.
				_cts = new CancellationTokenSource();
				_readTask = Task.Run(() => ReadLoop(_cts.Token));

				return true;
			}
			catch (Exception ex)
			{
				_logger.LogError(ex, "HfpSession.ConnectAsync failed for {Addr}", deviceAddress);
				CleanupConnection();
				return false;
			}
		});
	}

	private bool TryConnect(InTheHand.Net.BluetoothAddress address, Guid serviceUuid)
	{
		try
		{
			_client!.Connect(address, serviceUuid);
			return _client.Connected;
		}
		catch
		{
			return false;
		}
	}

	// ── SLC initialisation ──────────────────────────────────────────────────

	/// <summary>
	/// Perform minimal HFP Service Level Connection setup so the phone
	/// will send us unsolicited call indicators.
	/// </summary>
	private void InitSlc()
	{
		try
		{
			// 1. Exchange supported features (37 = EC/NR + CLI + enhanced call status + call control).
			SendLine("AT+BRSF=37");
			Thread.Sleep(300);
			DrainAvailable();

			// 2. Query indicator descriptions → figure out indices.
			SendLine("AT+CIND=?");
			Thread.Sleep(300);
			ParseCindDescription(DrainAvailable());

			// 3. Read current indicator values.
			SendLine("AT+CIND?");
			Thread.Sleep(300);
			ParseCindValues(DrainAvailable());

			// 4. Enable unsolicited indicator updates.
			SendLine("AT+CMER=3,0,0,1");
			Thread.Sleep(200);
			DrainAvailable();

			// 5. Enable caller-ID presentation.
			SendLine("AT+CLIP=1");
			Thread.Sleep(200);
			DrainAvailable();

			_logger.LogInformation("HFP SLC initialised (call idx={Call}, callsetup idx={Setup})",
				_callIndicatorIndex, _callSetupIndicatorIndex);
		}
		catch (Exception ex)
		{
			_logger.LogWarning(ex, "SLC init encountered errors (session may still work)");
		}
	}

	/// <summary>Read everything currently available in the stream buffer.</summary>
	private string DrainAvailable()
	{
		var sb = new StringBuilder();
		try
		{
			while (_reader != null && _client?.GetStream().DataAvailable == true)
			{
				int ch = _reader.Read();
				if (ch < 0) break;
				sb.Append((char)ch);
			}
		}
		catch { /* best effort */ }
		var text = sb.ToString();
		if (text.Length > 0) _logger.LogDebug("HFP drain: {Text}", text.Replace("\r", "\\r").Replace("\n", "\\n"));
		return text;
	}

	/// <summary>
	/// Parse the +CIND=? response to discover where "call" and "callsetup"
	/// live in the indicator list.
	/// Example: +CIND: ("service",(0,1)),("call",(0,1)),("callsetup",(0-3)),...
	/// </summary>
	private void ParseCindDescription(string response)
	{
		// Extract indicator names in order.
		int idx = 1;
		foreach (System.Text.RegularExpressions.Match m in
			System.Text.RegularExpressions.Regex.Matches(response, @"\(""(\w+)"""))
		{
			var name = m.Groups[1].Value.ToLowerInvariant();
			if (name == "call") _callIndicatorIndex = idx;
			else if (name is "callsetup" or "call_setup") _callSetupIndicatorIndex = idx;
			idx++;
		}
	}

	/// <summary>Parse +CIND? to read current indicator values.</summary>
	private void ParseCindValues(string response)
	{
		// +CIND: 1,0,0,0,5,0,4  →  values by index (1-based in our tracking)
		var m = System.Text.RegularExpressions.Regex.Match(response, @"\+CIND:\s*(.+)");
		if (!m.Success) return;
		var parts = m.Groups[1].Value.Trim().Split(',');
		if (_callIndicatorIndex > 0 && _callIndicatorIndex <= parts.Length)
		{
			if (parts[_callIndicatorIndex - 1].Trim() == "1")
			{
				SetCallState(CallState.Answered);
			}
		}
		if (_callSetupIndicatorIndex > 0 && _callSetupIndicatorIndex <= parts.Length)
		{
			if (parts[_callSetupIndicatorIndex - 1].Trim() == "1")
			{
				SetCallState(CallState.Ringing);
			}
		}
	}

	// ── Background read loop ────────────────────────────────────────────────

	private void ReadLoop(CancellationToken ct)
	{
		try
		{
			while (!ct.IsCancellationRequested && _reader != null)
			{
				var line = _reader.ReadLine();
				if (line == null) break; // stream closed
				line = line.Trim();
				if (line.Length == 0) continue;

				_logger.LogDebug("HFP < {Line}", line);
				ProcessLine(line);
			}
		}
		catch (Exception ex) when (!ct.IsCancellationRequested)
		{
			_logger.LogWarning(ex, "HFP read loop ended unexpectedly");
		}
		finally
		{
			IsConnected = false;
			if (CurrentCallState != CallState.Idle)
			{
				SetCallState(CallState.Idle);
			}
			_logger.LogInformation("HFP read loop exited");
		}
	}

	private void ProcessLine(string line)
	{
		if (line == "RING" || line == "+CRING")
		{
			if (CurrentCallState != CallState.Ringing)
			{
				SetCallState(CallState.Ringing);
			}
			return;
		}

		// +CLIP: "1234567890",129,,,"",0
		if (line.StartsWith("+CLIP:"))
		{
			var m = System.Text.RegularExpressions.Regex.Match(line, @"\+CLIP:\s*""([^""]*)""");
			if (m.Success)
			{
				CurrentCallerId = m.Groups[1].Value;
				CallStateChanged?.Invoke(CurrentCallState, CurrentCallerId);
				_logger.LogInformation("Caller ID: {Number}", CurrentCallerId);
			}
			return;
		}

		// +CIEV: <index>,<value>
		if (line.StartsWith("+CIEV:"))
		{
			var m = System.Text.RegularExpressions.Regex.Match(line, @"\+CIEV:\s*(\d+),(\d+)");
			if (m.Success)
			{
				int index = int.Parse(m.Groups[1].Value);
				int value = int.Parse(m.Groups[2].Value);
				HandleCiev(index, value);
			}
			return;
		}

		if (line is "NO CARRIER" or "+CEND" or "BUSY")
		{
			CurrentCallerId = null;
			SetCallState(CallState.Idle);
		}
	}

	private void HandleCiev(int index, int value)
	{
		// "call" indicator: 0 = no active call, 1 = active call
		if (index == _callIndicatorIndex)
		{
			if (value == 1 && CurrentCallState != CallState.Answered)
				SetCallState(CallState.Answered);
			else if (value == 0 && CurrentCallState != CallState.Idle)
			{
				CurrentCallerId = null;
				SetCallState(CallState.Idle);
			}
			return;
		}

		// "callsetup" indicator: 0=none, 1=incoming, 2=dialing, 3=alerting
		if (index == _callSetupIndicatorIndex)
		{
			if (value == 1 && CurrentCallState == CallState.Idle)
				SetCallState(CallState.Ringing);
			else if (value == 0 && CurrentCallState == CallState.Ringing)
			{
				// setup ended without "call" going to 1 → call was rejected/missed
				CurrentCallerId = null;
				SetCallState(CallState.Idle);
			}
		}
	}

	private void SetCallState(CallState state)
	{
		if (CurrentCallState == state) return;
		CurrentCallState = state;
		_logger.LogInformation("HFP call state → {State} (caller={Caller})", state, CurrentCallerId ?? "—");
		CallStateChanged?.Invoke(state, CurrentCallerId);
	}

	// ── Send AT commands ────────────────────────────────────────────────────

	public void SendCommand(string atCommand)
	{
		try
		{
			SendLine(atCommand);
			_logger.LogInformation("HFP > {Cmd}", atCommand);
		}
		catch (Exception ex)
		{
			_logger.LogError(ex, "Failed to send HFP command: {Cmd}", atCommand);
		}
	}

	private void SendLine(string line)
	{
		lock (_lock)
		{
			_writer?.WriteLine(line);
		}
	}

	// ── Disconnect / Dispose ────────────────────────────────────────────────

	public void Disconnect()
	{
		_cts?.Cancel();

		try { _readTask?.Wait(TimeSpan.FromSeconds(2)); } catch { /* best effort */ }

		CleanupConnection();
		IsConnected = false;
		CurrentCallState = CallState.Idle;
		CurrentCallerId = null;
	}

	private void CleanupConnection()
	{
		try { _writer?.Dispose(); } catch { }
		try { _reader?.Dispose(); } catch { }
		try { _client?.Dispose(); } catch { }
		_writer = null;
		_reader = null;
		_client = null;
		_cts?.Dispose();
		_cts = null;
		_readTask = null;
	}

	public void Dispose() => Disconnect();
}
