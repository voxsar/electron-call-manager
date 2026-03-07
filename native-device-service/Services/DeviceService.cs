using NativeDeviceService.Models;

namespace NativeDeviceService.Services;

// ---------------------------------------------------------------------------
// Top-level device service that aggregates Bluetooth, audio and telephony.
// This is the single entry point consumed by the HTTP endpoint layer.
// ---------------------------------------------------------------------------

/// <summary>Aggregated device-management contract.</summary>
public interface IDeviceService
{
    Task<StatusResponse> GetStatusAsync();
    Task<DevicesResponse> GetDevicesAsync();
    Task<OperationResult> ConnectAsync(string deviceId);
    Task<OperationResult> DisconnectAsync(string deviceId);
    Task<OperationResult> AnswerCallAsync(string? deviceId);
    Task<OperationResult> HangupCallAsync(string? deviceId);
}

/// <summary>
/// Concrete implementation that delegates to the specialised sub-services.
/// </summary>
public sealed class DeviceService(
    IBluetoothService bluetooth,
    IAudioService audio,
    ITelephonyService telephony
) : IDeviceService
{
    private const string ServiceVersion = "1.0.0";

    // -----------------------------------------------------------------------

    public async Task<StatusResponse> GetStatusAsync()
    {
        return new StatusResponse(
            Running: true,
            DevicesConnected: bluetooth.ConnectedCount,
            Version: ServiceVersion,
            CallState: telephony.CurrentState.ToString().ToLowerInvariant(),
            CallerId: telephony.CurrentCallerId,
            HfpMonitoring: telephony.IsMonitoring
        );
    }

    public async Task<DevicesResponse> GetDevicesAsync()
    {
        var btList    = await bluetooth.GetDevicesAsync();
        var audioList = await audio.GetDevicesAsync();

        var all = btList.Concat(audioList).ToList();
        return new DevicesResponse(Devices: all, Total: all.Count);
    }

    public async Task<OperationResult> ConnectAsync(string deviceId)
    {
        bool ok = await bluetooth.ConnectAsync(deviceId);
        if (ok)
        {
            // Start HFP monitoring for call detection (best-effort).
            bool hfp = await telephony.StartMonitoringAsync(deviceId);
            var msg = hfp
                ? $"Connected to device {deviceId} (HFP monitoring active)."
                : $"Connected to device {deviceId} (HFP monitoring unavailable — Windows may manage it).";
            return new OperationResult(true, msg, deviceId);
        }
        return new OperationResult(false, $"Device {deviceId} not found or connection failed.");
    }

    public async Task<OperationResult> DisconnectAsync(string deviceId)
    {
        await telephony.StopMonitoringAsync();
        bool ok = await bluetooth.DisconnectAsync(deviceId);
        return ok
            ? new OperationResult(true,  $"Disconnected device {deviceId}.", deviceId)
            : new OperationResult(false, $"Device {deviceId} not found or disconnect failed.");
    }

    public async Task<OperationResult> AnswerCallAsync(string? deviceId)
    {
        bool ok = await telephony.AnswerCallAsync(deviceId);
        return ok
            ? new OperationResult(true,  "Call answered.")
            : new OperationResult(false, "Failed to answer call.");
    }

    public async Task<OperationResult> HangupCallAsync(string? deviceId)
    {
        bool ok = await telephony.HangupCallAsync(deviceId);
        return ok
            ? new OperationResult(true,  "Call ended.")
            : new OperationResult(false, "Failed to hang up call.");
    }
}
