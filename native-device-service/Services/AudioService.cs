using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NativeDeviceService.Models;

namespace NativeDeviceService.Services;

// ---------------------------------------------------------------------------
// Audio service – enumerates Windows audio endpoints via NAudio / WASAPI and
// monitors Bluetooth HFP device state changes to detect incoming calls.
// ---------------------------------------------------------------------------

/// <summary>Contract for audio device management and routing.</summary>
public interface IAudioService
{
	/// <summary>Return all detected audio input/output devices.</summary>
	Task<IReadOnlyList<DeviceInfo>> GetDevicesAsync();

	/// <summary>Route audio output to the specified device.</summary>
	Task<bool> SetOutputDeviceAsync(string deviceId);

	/// <summary>Route audio input from the specified device.</summary>
	Task<bool> SetInputDeviceAsync(string deviceId);

	/// <summary>Whether a Bluetooth HFP call is currently active (audio endpoint is active).</summary>
	bool IsBtHfpCallActive { get; }

	/// <summary>Device ID of the active BT HFP output endpoint, if any.</summary>
	string? BtHfpOutputDeviceId { get; }

	/// <summary>Device ID of the active BT HFP input endpoint, if any.</summary>
	string? BtHfpInputDeviceId { get; }

	/// <summary>Raised when the BT HFP call-active state changes.</summary>
	event Action<bool>? BtHfpCallActiveChanged;
}

/// <summary>
/// NAudio/WASAPI implementation – enumerates real audio endpoints and monitors
/// Bluetooth HFP device state transitions for call detection.
/// </summary>
public sealed class AudioService : IAudioService, IMMNotificationClient, IDisposable
{
	private readonly ILogger<AudioService> _logger;
	private MMDeviceEnumerator? _enumerator;
	private Timer? _rescanTimer;
	private readonly object _lock = new();

	// BT HFP tracking
	private bool _btHfpCallActive;
	private string? _btHfpOutputId;
	private string? _btHfpInputId;

	public bool IsBtHfpCallActive => _btHfpCallActive;
	public string? BtHfpOutputDeviceId => _btHfpOutputId;
	public string? BtHfpInputDeviceId => _btHfpInputId;
	public event Action<bool>? BtHfpCallActiveChanged;

	public AudioService(ILogger<AudioService> logger)
	{
		_logger = logger;
		try
		{
			_enumerator = new MMDeviceEnumerator();
			_enumerator.RegisterEndpointNotificationCallback(this);
			ScanBtHfpEndpoints();
			_logger.LogInformation("AudioService initialised – monitoring audio endpoints");
		}
		catch (Exception ex)
		{
			_logger.LogWarning(ex, "AudioService could not initialise WASAPI (audio monitoring disabled)");
		}
	}

	// ── Device enumeration ───────────────────────────────────────────────────

	public Task<IReadOnlyList<DeviceInfo>> GetDevicesAsync()
	{
		var devices = new List<DeviceInfo>();
		if (_enumerator is null)
		{
			IReadOnlyList<DeviceInfo> empty = devices;
			return Task.FromResult(empty);
		}

		try
		{
			foreach (var flow in new[] { DataFlow.Render, DataFlow.Capture })
			{
				using var collection = _enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active | DeviceState.Unplugged);
				foreach (var dev in collection)
				{
					try
					{
						var isHfp = IsBluetoothHfpDevice(dev);
						var namePrefix = isHfp ? "[BT-HFP] " : "";
						devices.Add(new DeviceInfo(
							Id: dev.ID,
							Name: $"{namePrefix}{dev.FriendlyName}",
							Type: "audio",
							Connected: dev.State == DeviceState.Active,
							Address: null
						));
					}
					catch (Exception ex)
					{
						_logger.LogDebug(ex, "Skipping audio device (error reading properties)");
					}
				}
			}
		}
		catch (Exception ex)
		{
			_logger.LogWarning(ex, "Error enumerating audio devices");
		}

		IReadOnlyList<DeviceInfo> result = devices;
		return Task.FromResult(result);
	}

	public Task<bool> SetOutputDeviceAsync(string deviceId)
	{
		_logger.LogInformation("SetOutputDevice -> {DeviceId}", deviceId);
		return Task.FromResult(true);
	}

	public Task<bool> SetInputDeviceAsync(string deviceId)
	{
		_logger.LogInformation("SetInputDevice -> {DeviceId}", deviceId);
		return Task.FromResult(true);
	}

	// ── BT HFP endpoint scanning ────────────────────────────────────────────

	private static bool IsBluetoothHfpDevice(MMDevice device)
	{
		try
		{
			var name = device.FriendlyName?.ToLowerInvariant() ?? "";
			return name.Contains("hands-free") || name.Contains("handsfree");
		}
		catch
		{
			return false;
		}
	}

	private void ScanBtHfpEndpoints()
	{
		lock (_lock)
		{
			if (_enumerator is null) return;

			string? outputId = null;
			string? inputId = null;

			try
			{
				foreach (var flow in new[] { DataFlow.Render, DataFlow.Capture })
				{
					using var collection = _enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active);
					foreach (var dev in collection)
					{
						try
						{
							if (!IsBluetoothHfpDevice(dev)) continue;
							if (flow == DataFlow.Render)
								outputId = dev.ID;
							else
								inputId = dev.ID;
						}
						catch { /* skip */ }
					}
				}
			}
			catch (Exception ex)
			{
				_logger.LogDebug(ex, "Error scanning BT HFP endpoints");
			}

			bool nowActive = outputId != null || inputId != null;
			bool changed = nowActive != _btHfpCallActive;

			_btHfpOutputId = outputId;
			_btHfpInputId = inputId;
			_btHfpCallActive = nowActive;

			if (changed)
			{
				_logger.LogInformation(
					"BT HFP call active={Active} (output={Out}, input={In})",
					nowActive, outputId ?? "none", inputId ?? "none");
				BtHfpCallActiveChanged?.Invoke(nowActive);
			}
		}
	}

	/// <summary>Schedule a debounced rescan (avoids re-entrancy from COM callbacks).</summary>
	private void ScheduleRescan()
	{
		_rescanTimer?.Dispose();
		_rescanTimer = new Timer(_ => ScanBtHfpEndpoints(), null, 500, Timeout.Infinite);
	}

	// ── IMMNotificationClient callbacks ──────────────────────────────────────

	void IMMNotificationClient.OnDeviceStateChanged(string deviceId, DeviceState newState) => ScheduleRescan();
	void IMMNotificationClient.OnDeviceAdded(string deviceId) => ScheduleRescan();
	void IMMNotificationClient.OnDeviceRemoved(string deviceId) => ScheduleRescan();
	void IMMNotificationClient.OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId) { }
	void IMMNotificationClient.OnPropertyValueChanged(string deviceId, PropertyKey key) { }

	// ── Cleanup ──────────────────────────────────────────────────────────────

	public void Dispose()
	{
		_rescanTimer?.Dispose();
		if (_enumerator is not null)
		{
			try { _enumerator.UnregisterEndpointNotificationCallback(this); } catch { }
			_enumerator = null;
		}
	}
}
