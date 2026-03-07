namespace NativeDeviceService.Models;

// ---------------------------------------------------------------------------
// Request / Response models for the local HTTP API.
// Each record is serialised to JSON by the ASP.NET Core minimal-API pipeline.
// ---------------------------------------------------------------------------

/// <summary>Response returned by GET /status.</summary>
public record StatusResponse(
	bool Running,
	int DevicesConnected,
	string Version,
	string CallState = "idle",
	string? CallerId = null,
	bool HfpMonitoring = false
);

/// <summary>A single discovered device (Bluetooth, audio, serial, …).</summary>
public record DeviceInfo(
	string Id,
	string Name,
	string Type,       // "bluetooth" | "audio" | "serial"
	bool Connected,
	string? Address    // MAC address for Bluetooth; null otherwise
);

/// <summary>Response returned by GET /devices.</summary>
public record DevicesResponse(
	IReadOnlyList<DeviceInfo> Devices,
	int Total
);

/// <summary>Request body for POST /connect and POST /disconnect.</summary>
public record DeviceRequest(
	string DeviceId
);

/// <summary>Generic operation result used by most POST endpoints.</summary>
public record OperationResult(
	bool Success,
	string Message,
	string? DeviceId = null
);

/// <summary>Request body for POST /answer-call (optional – may carry metadata).</summary>
public record AnswerCallRequest(
	string? DeviceId = null
);

/// <summary>Request body for POST /hangup-call (optional – may carry metadata).</summary>
public record HangupCallRequest(
	string? DeviceId = null
);
