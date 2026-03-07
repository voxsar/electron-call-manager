using InTheHand.Net.Bluetooth;
using InTheHand.Net.Sockets;

namespace NativeDeviceService.Services;

// ---------------------------------------------------------------------------
// Telephony event service – monitors a connected Bluetooth phone for incoming
// calls via a persistent HFP RFCOMM session, and routes answer / hang-up
// commands through the same connection.
// ---------------------------------------------------------------------------

/// <summary>Call state reported by the telephony layer.</summary>
public enum CallState { Idle, Ringing, Answered, Ended }

/// <summary>Contract for telephony / call-control operations.</summary>
public interface ITelephonyService
{
	/// <summary>Current call state.</summary>
	CallState CurrentState { get; }

	/// <summary>Current caller ID (if known).</summary>
	string? CurrentCallerId { get; }

	/// <summary>Whether HFP monitoring is active.</summary>
	bool IsMonitoring { get; }

	/// <summary>Answer the active incoming call.</summary>
	Task<bool> AnswerCallAsync(string? deviceId);

	/// <summary>Hang up the active call.</summary>
	Task<bool> HangupCallAsync(string? deviceId);

	/// <summary>Start persistent HFP monitoring on a connected device.</summary>
	Task<bool> StartMonitoringAsync(string deviceAddress);

	/// <summary>Stop HFP monitoring.</summary>
	Task StopMonitoringAsync();
}

/// <summary>
/// Telephony implementation backed by <see cref="HfpSession"/>.
/// Maintains a persistent RFCOMM connection for call event monitoring and
/// sends AT commands (ATA / AT+CHUP) to answer and hang up calls.
/// </summary>
public sealed class TelephonyService : ITelephonyService, IDisposable
{
	private readonly IBluetoothService _bluetooth;
	private readonly IAudioService _audio;
	private readonly ILogger<TelephonyService> _logger;
	private readonly ILoggerFactory _loggerFactory;
	private HfpSession? _session;

	// Fallback call state detected via audio endpoint monitoring.
	private CallState _audioDetectedState = CallState.Idle;

	public TelephonyService(
		IBluetoothService bluetooth,
		IAudioService audio,
		ILogger<TelephonyService> logger,
		ILoggerFactory loggerFactory)
	{
		_bluetooth = bluetooth;
		_audio = audio;
		_logger = logger;
		_loggerFactory = loggerFactory;

		// Subscribe to BT HFP audio endpoint state changes.
		_audio.BtHfpCallActiveChanged += OnBtHfpCallActiveChanged;
	}

	public CallState CurrentState
	{
		get
		{
			// Prefer HFP session state when connected.
			if (_session is { IsConnected: true })
				return _session.CurrentCallState;
			// Fall back to audio-detected state.
			return _audioDetectedState;
		}
	}

	public string? CurrentCallerId => _session?.CurrentCallerId;

	public bool IsMonitoring =>
		(_session?.IsConnected ?? false) || _audio.IsBtHfpCallActive;

	// ── Monitoring ──────────────────────────────────────────────────────────

	public async Task<bool> StartMonitoringAsync(string deviceAddress)
	{
		// Stop any existing session first.
		await StopMonitoringAsync();

		var session = new HfpSession(_loggerFactory.CreateLogger<HfpSession>());
		session.CallStateChanged += OnCallStateChanged;

		_logger.LogInformation("Starting HFP monitoring for {Addr}", deviceAddress);
		bool ok = await session.ConnectAsync(deviceAddress);

		if (ok)
		{
			_session = session;
			_logger.LogInformation("HFP monitoring active for {Addr}", deviceAddress);
		}
		else
		{
			session.CallStateChanged -= OnCallStateChanged;
			session.Dispose();
			_logger.LogWarning("HFP monitoring could not be started for {Addr} " +
				"(Windows may already manage this HFP connection — this is normal)", deviceAddress);
		}

		return ok;
	}

	public Task StopMonitoringAsync()
	{
		if (_session is not null)
		{
			_session.CallStateChanged -= OnCallStateChanged;
			_session.Disconnect();
			_session.Dispose();
			_session = null;
			_logger.LogInformation("HFP monitoring stopped");
		}
		return Task.CompletedTask;
	}

	private void OnCallStateChanged(CallState state, string? callerId)
	{
		_logger.LogInformation("Telephony state changed: {State}, caller={Caller}",
			state, callerId ?? "—");
	}

	private void OnBtHfpCallActiveChanged(bool active)
	{
		if (active)
		{
			if (_audioDetectedState == CallState.Idle)
			{
				_logger.LogInformation("BT HFP audio activated → reporting Ringing");
				_audioDetectedState = CallState.Ringing;
			}
		}
		else
		{
			if (_audioDetectedState != CallState.Idle)
			{
				_logger.LogInformation("BT HFP audio deactivated → reporting Idle");
				_audioDetectedState = CallState.Idle;
			}
		}
	}

	// ── Call control ────────────────────────────────────────────────────────

	public async Task<bool> AnswerCallAsync(string? deviceId)
	{
		_logger.LogInformation("AnswerCall requested, device={DeviceId}", deviceId ?? "any");

		// Update audio-detected state so we don't keep reporting Ringing.
		_audioDetectedState = CallState.Answered;

		// Use persistent session if available.
		if (_session is { IsConnected: true })
		{
			_session.SendCommand("ATA");
			return true;
		}

		// Fallback: open a short-lived RFCOMM connection (best-effort).
		var result = await SendAtFallbackAsync(deviceId, "ATA");
		// Even if the AT command failed (Windows owns HFP), return true
		// because the audio is already active via BT HFP.
		if (!result && _audio.IsBtHfpCallActive)
		{
			_logger.LogInformation("AT fallback failed but BT HFP audio is active \u2013 treating as answered");
			return true;
		}
		return result;
	}

	public async Task<bool> HangupCallAsync(string? deviceId)
	{
		_logger.LogInformation("HangupCall requested, device={DeviceId}", deviceId ?? "any");

		if (_session is { IsConnected: true })
		{
			_session.SendCommand("AT+CHUP");
			return true;
		}

		return await SendAtFallbackAsync(deviceId, "AT+CHUP");
	}

	// ── Fallback (short-lived connection) ───────────────────────────────────

	// HFP AG (Audio Gateway) UUID – the phone advertises this role.
	private static readonly Guid HfpAgServiceUuid = new("0000111f-0000-1000-8000-00805f9b34fb");
	private static readonly Guid HfpServiceUuid = new("0000111e-0000-1000-8000-00805f9b34fb");

	private async Task<bool> SendAtFallbackAsync(string? deviceId, string command)
	{
		try
		{
			var address = await ResolveDeviceAddressAsync(deviceId);
			if (address is null) return false;

			return await Task.Run(() =>
			{
				using var client = new BluetoothClient();
				// Try AG UUID first (phone role), then HFP unit UUID.
				bool connected = false;
				try { client.Connect(address, HfpAgServiceUuid); connected = client.Connected; } catch { }
				if (!connected)
				{
					try { client.Connect(address, HfpServiceUuid); connected = client.Connected; } catch { }
				}
				if (!connected) return false;

				using var stream = client.GetStream();
				var data = System.Text.Encoding.ASCII.GetBytes(command + "\r");
				stream.Write(data, 0, data.Length);
				stream.Flush();
				_logger.LogInformation("Sent (fallback) {Cmd} to {Addr}", command, address);
				return true;
			});
		}
		catch (Exception ex)
		{
			_logger.LogError(ex, "Fallback AT command failed: {Cmd}", command);
			return false;
		}
	}

	private async Task<InTheHand.Net.BluetoothAddress?> ResolveDeviceAddressAsync(string? deviceId)
	{
		if (!string.IsNullOrWhiteSpace(deviceId))
		{
			try { return InTheHand.Net.BluetoothAddress.Parse(deviceId); }
			catch { /* not a valid address */ }
		}

		var devices = await _bluetooth.GetDevicesAsync();
		var connected = devices.FirstOrDefault(d => d.Connected);
		if (connected is null) return null;

		try { return InTheHand.Net.BluetoothAddress.Parse(connected.Address ?? connected.Id); }
		catch { return null; }
	}

	public void Dispose()
	{
		_audio.BtHfpCallActiveChanged -= OnBtHfpCallActiveChanged;
		_session?.Dispose();
	}
}
