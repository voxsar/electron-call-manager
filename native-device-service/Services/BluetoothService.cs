using InTheHand.Net.Bluetooth;
using InTheHand.Net.Sockets;
using NativeDeviceService.Models;

namespace NativeDeviceService.Services;

// ---------------------------------------------------------------------------
// Bluetooth HFP service – real implementation using 32feet.NET (InTheHand).
//
// Discovers paired Bluetooth devices and manages connections.
// Requires Windows Bluetooth radio to be available and enabled.
// ---------------------------------------------------------------------------

/// <summary>Contract for Bluetooth device management.</summary>
public interface IBluetoothService
{
	/// <summary>Return all currently known Bluetooth devices.</summary>
	Task<IReadOnlyList<DeviceInfo>> GetDevicesAsync();

	/// <summary>Attempt to connect a device by its Bluetooth address or ID.</summary>
	Task<bool> ConnectAsync(string deviceId);

	/// <summary>Disconnect a device.</summary>
	Task<bool> DisconnectAsync(string deviceId);

	/// <summary>Number of devices currently in the connected state.</summary>
	int ConnectedCount { get; }
}

/// <summary>
/// Real Bluetooth implementation using 32feet.NET (InTheHand.Net.Bluetooth).
/// Discovers paired devices and manages HFP connections.
/// </summary>
public sealed class BluetoothService : IBluetoothService, IDisposable
{
	private readonly ILogger<BluetoothService> _logger;

	// Track which devices we consider "connected" (by address string key).
	private readonly Dictionary<string, BluetoothDeviceInfo> _connectedDevices = new();
	private readonly object _lock = new();

	public BluetoothService(ILogger<BluetoothService> logger)
	{
		_logger = logger;
	}

	public int ConnectedCount
	{
		get { lock (_lock) return _connectedDevices.Count; }
	}

	/// <summary>
	/// Discover all paired Bluetooth devices visible to the system.
	/// Returns both connected and paired-but-disconnected devices.
	/// </summary>
	public Task<IReadOnlyList<DeviceInfo>> GetDevicesAsync()
	{
		var results = new List<DeviceInfo>();

		try
		{
			using var client = new BluetoothClient();
			// Get paired (remembered) devices – quick, no radio scan needed.
			var paired = client.PairedDevices;

			foreach (var device in paired)
			{
				var addr = device.DeviceAddress.ToString();
				bool isConnected;
				lock (_lock) { isConnected = _connectedDevices.ContainsKey(addr); }

				// Also check the OS-level connected flag.
				bool osConnected = false;
				try { osConnected = device.Connected; }
				catch { /* some drivers throw on property access */ }

				results.Add(new DeviceInfo(
					Id: addr,
					Name: string.IsNullOrWhiteSpace(device.DeviceName) ? $"Device {addr}" : device.DeviceName,
					Type: "bluetooth",
					Connected: isConnected || osConnected,
					Address: addr
				));
			}

			_logger.LogInformation("Bluetooth scan found {Count} paired device(s)", results.Count);
		}
		catch (Exception ex)
		{
			_logger.LogError(ex, "Bluetooth device enumeration failed – is a Bluetooth radio available?");
		}

		return Task.FromResult<IReadOnlyList<DeviceInfo>>(results.AsReadOnly());
	}

	/// <summary>
	/// Connect to a paired device by address / ID.
	/// Attempts Handsfree (HFP) profile first, then falls back to Generic Audio.
	/// </summary>
	public async Task<bool> ConnectAsync(string deviceId)
	{
		try
		{
			var address = InTheHand.Net.BluetoothAddress.Parse(deviceId);
			var device = new BluetoothDeviceInfo(address);

			_logger.LogInformation("Connecting to {Name} ({Address})…", device.DeviceName, deviceId);

			// Try Hands-Free profile (for phone calls)
			bool connected = await TryConnectProfileAsync(device, BluetoothService_HFP);

			if (!connected)
			{
				// Fallback: try generic RFCOMM serial port profile
				_logger.LogInformation("HFP unavailable, trying Serial Port profile for {Address}…", deviceId);
				connected = await TryConnectProfileAsync(device, BluetoothService_SPP);
			}

			if (connected)
			{
				lock (_lock) { _connectedDevices[deviceId] = device; }
				_logger.LogInformation("Connected to {Name} ({Address})", device.DeviceName, deviceId);
			}
			else
			{
				// Even if profile-level connect didn't work, mark as "connected"
				// if the OS already shows the device connected (e.g. paired phone).
				bool osConnected = false;
				try { osConnected = device.Connected; } catch { }
				if (osConnected)
				{
					lock (_lock) { _connectedDevices[deviceId] = device; }
					_logger.LogInformation("Device {Address} is OS-level connected (paired)", deviceId);
					connected = true;
				}
				else
				{
					_logger.LogWarning("Failed to connect to {Address}", deviceId);
				}
			}

			return connected;
		}
		catch (Exception ex)
		{
			_logger.LogError(ex, "Bluetooth connect failed for {DeviceId}", deviceId);
			return false;
		}
	}

	public Task<bool> DisconnectAsync(string deviceId)
	{
		try
		{
			lock (_lock)
			{
				if (_connectedDevices.Remove(deviceId))
				{
					_logger.LogInformation("Disconnected device {DeviceId}", deviceId);
					return Task.FromResult(true);
				}
			}

			_logger.LogWarning("Device {DeviceId} was not in connected set", deviceId);
			return Task.FromResult(false);
		}
		catch (Exception ex)
		{
			_logger.LogError(ex, "Bluetooth disconnect failed for {DeviceId}", deviceId);
			return Task.FromResult(false);
		}
	}

	public void Dispose()
	{
		lock (_lock) { _connectedDevices.Clear(); }
	}

	// ── Profile UUIDs ──────────────────────────────────────────────────────

	/// <summary>Hands-Free Profile (HFP) UUID.</summary>
	private static readonly Guid BluetoothService_HFP =
		new("0000111e-0000-1000-8000-00805f9b34fb");

	/// <summary>Serial Port Profile (SPP) UUID – fallback.</summary>
	private static readonly Guid BluetoothService_SPP =
		new("00001101-0000-1000-8000-00805f9b34fb");

	/// <summary>
	/// Attempt to open an RFCOMM connection to the device on the given profile.
	/// </summary>
	private async Task<bool> TryConnectProfileAsync(BluetoothDeviceInfo device, Guid serviceUuid)
	{
		try
		{
			return await Task.Run(() =>
			{
				using var client = new BluetoothClient();
				var ep = new BluetoothEndPoint(device.DeviceAddress, serviceUuid);
				client.Connect(ep);
				return client.Connected;
			});
		}
		catch (Exception ex)
		{
			_logger.LogDebug(ex, "Profile {Profile} connect failed for {Address}",
				serviceUuid, device.DeviceAddress);
			return false;
		}
	}
}
