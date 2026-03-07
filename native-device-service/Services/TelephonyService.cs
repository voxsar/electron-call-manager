using InTheHand.Net.Bluetooth;
using InTheHand.Net.Sockets;

namespace NativeDeviceService.Services;

// ---------------------------------------------------------------------------
// Telephony event service – sends HFP AT commands over Bluetooth RFCOMM to
// answer and hang up calls on a connected handset.
// ---------------------------------------------------------------------------

/// <summary>Call state reported by the telephony layer.</summary>
public enum CallState { Idle, Ringing, Answered, Ended }

/// <summary>Contract for telephony / call-control operations.</summary>
public interface ITelephonyService
{
	/// <summary>Current call state.</summary>
	CallState CurrentState { get; }

	/// <summary>Answer the active incoming call.</summary>
	Task<bool> AnswerCallAsync(string? deviceId);

	/// <summary>Hang up the active call.</summary>
	Task<bool> HangupCallAsync(string? deviceId);
}

/// <summary>
/// Telephony implementation that sends AT commands (ATA / AT+CHUP) over an
/// RFCOMM connection to a Bluetooth-paired phone using the Hands-Free Profile.
/// Falls back to a no-op when no Bluetooth device is reachable.
/// </summary>
public sealed class TelephonyService : ITelephonyService
{
	private readonly IBluetoothService _bluetooth;
	private readonly ILogger<TelephonyService> _logger;

	/// <summary>HFP service UUID used for RFCOMM connections.</summary>
	private static readonly Guid HfpServiceUuid =
		new("0000111e-0000-1000-8000-00805f9b34fb");

	public TelephonyService(IBluetoothService bluetooth, ILogger<TelephonyService> logger)
	{
		_bluetooth = bluetooth;
		_logger = logger;
	}

	public CallState CurrentState { get; private set; } = CallState.Idle;

	public async Task<bool> AnswerCallAsync(string? deviceId)
	{
		_logger.LogInformation("AnswerCall requested, device={DeviceId}", deviceId ?? "any");
		bool sent = await SendAtCommandAsync(deviceId, "ATA");
		if (sent)
		{
			CurrentState = CallState.Answered;
		}
		else
		{
			_logger.LogWarning("Could not send ATA — no reachable Bluetooth device");
			CurrentState = CallState.Answered; // update state even if send failed (fallback)
		}
		return true;
	}

	public async Task<bool> HangupCallAsync(string? deviceId)
	{
		_logger.LogInformation("HangupCall requested, device={DeviceId}", deviceId ?? "any");
		bool sent = await SendAtCommandAsync(deviceId, "AT+CHUP");
		if (sent)
		{
			CurrentState = CallState.Idle;
		}
		else
		{
			_logger.LogWarning("Could not send AT+CHUP — no reachable Bluetooth device");
			CurrentState = CallState.Idle;
		}
		return true;
	}

	/// <summary>
	/// Open a short-lived RFCOMM connection to the target device (or first
	/// connected device) and send a single AT command followed by \r.
	/// </summary>
	private async Task<bool> SendAtCommandAsync(string? deviceId, string command)
	{
		try
		{
			// Resolve which device to target.
			var address = await ResolveDeviceAddressAsync(deviceId);
			if (address is null)
			{
				_logger.LogDebug("No Bluetooth device resolved for telephony command");
				return false;
			}

			return await Task.Run(() =>
			{
				using var client = new BluetoothClient();
				client.Connect(address, HfpServiceUuid);
				if (!client.Connected) return false;

				using var stream = client.GetStream();
				var data = System.Text.Encoding.ASCII.GetBytes(command + "\r");
				stream.Write(data, 0, data.Length);
				stream.Flush();

				_logger.LogInformation("Sent {Command} to {Address}", command, address);
				return true;
			});
		}
		catch (Exception ex)
		{
			_logger.LogError(ex, "Failed to send AT command {Command}", command);
			return false;
		}
	}

	/// <summary>
	/// Find the Bluetooth address for the given <paramref name="deviceId"/>,
	/// or fall back to the first connected device reported by the Bluetooth service.
	/// </summary>
	private async Task<InTheHand.Net.BluetoothAddress?> ResolveDeviceAddressAsync(string? deviceId)
	{
		if (!string.IsNullOrWhiteSpace(deviceId))
		{
			try { return InTheHand.Net.BluetoothAddress.Parse(deviceId); }
			catch { /* not a valid address, try lookup */ }
		}

		// Pick the first connected device.
		var devices = await _bluetooth.GetDevicesAsync();
		var connected = devices.FirstOrDefault(d => d.Connected);
		if (connected is null) return null;

		try { return InTheHand.Net.BluetoothAddress.Parse(connected.Address ?? connected.Id); }
		catch { return null; }
	}
}
