using NativeDeviceService.Models;

namespace NativeDeviceService.Services;

// ---------------------------------------------------------------------------
// Bluetooth HFP service – stub ready for a real implementation.
// Future implementation should use Windows.Devices.Bluetooth (WinRT) or
// a cross-platform library such as InTheHand.Net.Bluetooth.
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
/// Stub implementation – returns no real devices.
/// Replace the body of each method with platform-specific Bluetooth APIs when ready.
/// </summary>
public sealed class BluetoothService : IBluetoothService
{
    // Simulated in-memory list of discovered devices (replace with real discovery).
    private readonly List<DeviceInfo> _devices = [];

    public int ConnectedCount =>
        _devices.Count(d => d.Connected);

    public Task<IReadOnlyList<DeviceInfo>> GetDevicesAsync()
    {
        // TODO: Replace with actual Bluetooth device enumeration.
        // Example (WinRT): DeviceInformation.FindAllAsync(BluetoothDevice.GetDeviceSelector())
        IReadOnlyList<DeviceInfo> result = _devices.AsReadOnly();
        return Task.FromResult(result);
    }

    public Task<bool> ConnectAsync(string deviceId)
    {
        // TODO: Open HFP/A2DP profile connection to the device.
        var device = _devices.FirstOrDefault(d => d.Id == deviceId);
        if (device is null)
            return Task.FromResult(false);

        // Mutate connected flag (record types are immutable – rebuild the entry).
        _devices[_devices.IndexOf(device)] = device with { Connected = true };
        return Task.FromResult(true);
    }

    public Task<bool> DisconnectAsync(string deviceId)
    {
        // TODO: Close the HFP/A2DP profile connection.
        var device = _devices.FirstOrDefault(d => d.Id == deviceId);
        if (device is null)
            return Task.FromResult(false);

        _devices[_devices.IndexOf(device)] = device with { Connected = false };
        return Task.FromResult(true);
    }
}
