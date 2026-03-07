using NativeDeviceService.Models;
using NativeDeviceService.Services;

namespace NativeDeviceService.Endpoints;

// ---------------------------------------------------------------------------
// HTTP endpoint definitions registered with the ASP.NET Core minimal-API pipeline.
// Each public static method maps to one API route.
// ---------------------------------------------------------------------------

/// <summary>Registers all /api/* endpoints on the <see cref="WebApplication"/>.</summary>
public static class DeviceEndpoints
{
    /// <summary>Call this from Program.cs to wire up all routes.</summary>
    public static void MapDeviceEndpoints(this WebApplication app)
    {
        // GET /status – liveness + connected-device count
        app.MapGet("/status", GetStatus)
           .WithName("GetStatus")
           .Produces<StatusResponse>();

        // GET /devices – list all known devices
        app.MapGet("/devices", GetDevices)
           .WithName("GetDevices")
           .Produces<DevicesResponse>();

        // POST /connect – connect a device by ID
        app.MapPost("/connect", ConnectDevice)
           .WithName("ConnectDevice")
           .Produces<OperationResult>()
           .Accepts<DeviceRequest>("application/json");

        // POST /disconnect – disconnect a device by ID
        app.MapPost("/disconnect", DisconnectDevice)
           .WithName("DisconnectDevice")
           .Produces<OperationResult>()
           .Accepts<DeviceRequest>("application/json");

        // POST /answer-call – answer the active incoming call
        app.MapPost("/answer-call", AnswerCall)
           .WithName("AnswerCall")
           .Produces<OperationResult>()
           .Accepts<AnswerCallRequest>("application/json");

        // POST /hangup-call – hang up the active call
        app.MapPost("/hangup-call", HangupCall)
           .WithName("HangupCall")
           .Produces<OperationResult>()
           .Accepts<HangupCallRequest>("application/json");
    }

    // -----------------------------------------------------------------------
    // Handlers – each is a static async method for clarity and testability.
    // -----------------------------------------------------------------------

    private static async Task<IResult> GetStatus(IDeviceService svc)
    {
        var result = await svc.GetStatusAsync();
        return Results.Ok(result);
    }

    private static async Task<IResult> GetDevices(IDeviceService svc)
    {
        var result = await svc.GetDevicesAsync();
        return Results.Ok(result);
    }

    private static async Task<IResult> ConnectDevice(
        DeviceRequest? req,
        IDeviceService svc)
    {
        if (req is null || string.IsNullOrWhiteSpace(req.DeviceId))
            return Results.BadRequest(new OperationResult(false, "DeviceId is required."));

        var result = await svc.ConnectAsync(req.DeviceId);
        return result.Success ? Results.Ok(result) : Results.NotFound(result);
    }

    private static async Task<IResult> DisconnectDevice(
        DeviceRequest? req,
        IDeviceService svc)
    {
        if (req is null || string.IsNullOrWhiteSpace(req.DeviceId))
            return Results.BadRequest(new OperationResult(false, "DeviceId is required."));

        var result = await svc.DisconnectAsync(req.DeviceId);
        return result.Success ? Results.Ok(result) : Results.NotFound(result);
    }

    private static async Task<IResult> AnswerCall(
        AnswerCallRequest? req,
        IDeviceService svc)
    {
        var result = await svc.AnswerCallAsync(req?.DeviceId);
        return result.Success ? Results.Ok(result) : Results.Problem(result.Message);
    }

    private static async Task<IResult> HangupCall(
        HangupCallRequest? req,
        IDeviceService svc)
    {
        var result = await svc.HangupCallAsync(req?.DeviceId);
        return result.Success ? Results.Ok(result) : Results.Problem(result.Message);
    }
}
