import { desktopCapturer, screen } from "electron";
import { spawn } from "child_process";
import { COMPUTER_TOOL_NAME } from "../src/computerTool";

type JsonRecord = Record<string, unknown>;

type ComputerToolResponse = {
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
  >;
  success: boolean;
};

const KEY_CODES: Record<string, number> = {
  BACKSPACE: 0x08,
  TAB: 0x09,
  ENTER: 0x0d,
  SHIFT: 0x10,
  CTRL: 0x11,
  CONTROL: 0x11,
  ALT: 0x12,
  ESC: 0x1b,
  ESCAPE: 0x1b,
  SPACE: 0x20,
  PAGEUP: 0x21,
  PAGEDOWN: 0x22,
  END: 0x23,
  HOME: 0x24,
  LEFT: 0x25,
  UP: 0x26,
  RIGHT: 0x27,
  DOWN: 0x28,
  DELETE: 0x2e,
  META: 0x5b,
  WIN: 0x5b,
  F1: 0x70,
  F2: 0x71,
  F3: 0x72,
  F4: 0x73,
  F5: 0x74,
  F6: 0x75,
  F7: 0x76,
  F8: 0x77,
  F9: 0x78,
  F10: 0x79,
  F11: 0x7a,
  F12: 0x7b,
};

const MOUSE_FLAGS = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
} as const;

const NATIVE_METHODS = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CodexComputerUseNative {
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput {
    public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KeyboardInput {
    public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct HardwareInput {
    public uint message; public ushort low; public ushort high;
  }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public MouseInput mouse;
    [FieldOffset(0)] public KeyboardInput keyboard;
    [FieldOffset(0)] public HardwareInput hardware;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Input {
    public uint type; public InputUnion data;
  }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, Input[] inputs, int size);
  private static void SendVirtualKey(ushort virtualKey) {
    var inputs = new Input[] {
      new Input { type = 1, data = new InputUnion { keyboard = new KeyboardInput { virtualKey = virtualKey } } },
      new Input { type = 1, data = new InputUnion { keyboard = new KeyboardInput { virtualKey = virtualKey, flags = 0x0002 } } },
    };
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
  private static void SendUnicodeCharacter(char character) {
    var inputs = new Input[] {
      new Input { type = 1, data = new InputUnion { keyboard = new KeyboardInput { scanCode = character, flags = 0x0004 } } },
      new Input { type = 1, data = new InputUnion { keyboard = new KeyboardInput { scanCode = character, flags = 0x0004 | 0x0002 } } },
    };
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
  public static void SendUnicode(string text) {
    foreach (char character in text) {
      if (character == '\r') continue;
      if (character == '\n') { SendVirtualKey(0x0D); continue; }
      if (character == '\t') {
        SendUnicodeCharacter(' '); SendUnicodeCharacter(' '); SendUnicodeCharacter(' '); SendUnicodeCharacter(' ');
        continue;
      }
      SendUnicodeCharacter(character);
    }
  }
}`;

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function runPowerShell(script: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Computer use currently supports Windows only.");
  }
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Computer action timed out."));
    }, 12_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
    });
  });
}

function integerArgument(args: JsonRecord, name: string, fallback?: number): number {
  const value = args[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return value;
}

function stringArgument(args: JsonRecord, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function displayPoint(args: JsonRecord, xName = "x", yName = "y") {
  const display = screen.getPrimaryDisplay();
  const physicalWidth = Math.round(display.size.width * display.scaleFactor);
  const physicalHeight = Math.round(display.size.height * display.scaleFactor);
  const x = integerArgument(args, xName);
  const y = integerArgument(args, yName);
  if (x < 0 || y < 0 || x >= physicalWidth || y >= physicalHeight) {
    throw new Error(
      `Coordinates (${x}, ${y}) are outside the primary display (${physicalWidth}x${physicalHeight}).`,
    );
  }
  return {
    x: Math.round(display.bounds.x * display.scaleFactor) + x,
    y: Math.round(display.bounds.y * display.scaleFactor) + y,
  };
}

function keyCode(name: string): number {
  const normalized = name.trim().toUpperCase();
  if (normalized.length === 1 && /^[A-Z0-9]$/.test(normalized)) {
    return normalized.charCodeAt(0);
  }
  const code = KEY_CODES[normalized];
  if (code === undefined) throw new Error(`Unsupported key: ${name}`);
  return code;
}

async function pressKeys(args: JsonRecord) {
  if (!Array.isArray(args.keys) || args.keys.length === 0) {
    throw new Error("keys must contain at least one key.");
  }
  const codes = args.keys.map((value) => {
    if (typeof value !== "string") throw new Error("Every key must be a string.");
    return keyCode(value);
  });
  const down = codes.map((code) => `[CodexComputerUseNative]::keybd_event(${code}, 0, 0, [UIntPtr]::Zero)`).join("\n");
  const up = [...codes].reverse().map((code) => `[CodexComputerUseNative]::keybd_event(${code}, 0, 2, [UIntPtr]::Zero)`).join("\n");
  await runPowerShell(`Add-Type -TypeDefinition ${powershellLiteral(NATIVE_METHODS)}\n${down}\nStart-Sleep -Milliseconds 40\n${up}`);
}

async function typeText(args: JsonRecord) {
  const text = stringArgument(args, "text");
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const script = String.raw`
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
Add-Type -TypeDefinition ${powershellLiteral(NATIVE_METHODS)}
[CodexComputerUseNative]::SendUnicode($text)
`;
  await runPowerShell(script);
}

async function performAction(args: JsonRecord): Promise<string> {
  const action = stringArgument(args, "action");
  if (action === "screenshot") return "Captured the primary display.";
  if (action === "wait") {
    const milliseconds = Math.min(10_000, Math.max(0, integerArgument(args, "milliseconds", 1000)));
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return `Waited ${milliseconds} ms.`;
  }
  if (action === "key") {
    await pressKeys(args);
    return "Pressed the requested key chord.";
  }
  if (action === "type") {
    await typeText(args);
    return "Typed the requested text.";
  }

  const point = displayPoint(args);
  const move = `[CodexComputerUseNative]::SetCursorPos(${point.x}, ${point.y}) | Out-Null`;
  if (action === "move") {
    await runPowerShell(`Add-Type -TypeDefinition ${powershellLiteral(NATIVE_METHODS)}\n${move}`);
    return `Moved the pointer to (${args.x}, ${args.y}).`;
  }
  if (action === "scroll") {
    const deltaX = integerArgument(args, "deltaX", 0);
    const deltaY = integerArgument(args, "deltaY", 0);
    const vertical = deltaY === 0 ? "" : `[CodexComputerUseNative]::mouse_event(0x0800, 0, 0, ${deltaY}, [UIntPtr]::Zero)`;
    const horizontal = deltaX === 0 ? "" : `[CodexComputerUseNative]::mouse_event(0x1000, 0, 0, ${deltaX}, [UIntPtr]::Zero)`;
    await runPowerShell(`Add-Type -TypeDefinition ${powershellLiteral(NATIVE_METHODS)}\n${move}\n${vertical}\n${horizontal}`);
    return `Scrolled at (${args.x}, ${args.y}).`;
  }
  if (action === "drag") {
    const start = displayPoint(args, "startX", "startY");
    await runPowerShell(`Add-Type -TypeDefinition ${powershellLiteral(NATIVE_METHODS)}
[CodexComputerUseNative]::SetCursorPos(${start.x}, ${start.y}) | Out-Null
[CodexComputerUseNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
[CodexComputerUseNative]::SetCursorPos(${point.x}, ${point.y}) | Out-Null
Start-Sleep -Milliseconds 80
[CodexComputerUseNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)`);
    return `Dragged from (${args.startX}, ${args.startY}) to (${args.x}, ${args.y}).`;
  }
  if (action === "click" || action === "double_click") {
    const button = typeof args.button === "string" ? args.button : "left";
    if (!(button in MOUSE_FLAGS)) throw new Error(`Unsupported mouse button: ${button}`);
    const flags = MOUSE_FLAGS[button as keyof typeof MOUSE_FLAGS];
    const click = `[CodexComputerUseNative]::mouse_event(${flags.down}, 0, 0, 0, [UIntPtr]::Zero)\n[CodexComputerUseNative]::mouse_event(${flags.up}, 0, 0, 0, [UIntPtr]::Zero)`;
    const clicks = action === "double_click" ? `${click}\nStart-Sleep -Milliseconds 90\n${click}` : click;
    await runPowerShell(`Add-Type -TypeDefinition ${powershellLiteral(NATIVE_METHODS)}\n${move}\n${clicks}`);
    return `${action === "double_click" ? "Double-clicked" : "Clicked"} ${button} at (${args.x}, ${args.y}).`;
  }
  throw new Error(`Unsupported computer action: ${action}`);
}

async function capturePrimaryDisplay(args?: JsonRecord) {
  const display = screen.getPrimaryDisplay();
  const fullWidth = Math.round(display.size.width * display.scaleFactor);
  const fullHeight = Math.round(display.size.height * display.scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: fullWidth, height: fullHeight },
    fetchWindowIcons: false,
  });
  const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error("Unable to capture the primary display.");
  let image = source.thumbnail;
  let originX = 0;
  let originY = 0;
  const cropRequested = args?.action === "screenshot" &&
    [args.x, args.y, args.width, args.height].some((value) => value !== undefined);
  if (cropRequested) {
    originX = integerArgument(args, "x");
    originY = integerArgument(args, "y");
    const width = integerArgument(args, "width");
    const height = integerArgument(args, "height");
    if (originX < 0 || originY < 0 || width < 1 || height < 1 || originX + width > fullWidth || originY + height > fullHeight) {
      throw new Error(`Screenshot crop (${originX}, ${originY}, ${width}, ${height}) is outside ${fullWidth}x${fullHeight}.`);
    }
    image = image.crop({ x: originX, y: originY, width, height });
  }
  const imageSize = image.getSize();
  const losslessCrop = cropRequested && imageSize.width <= 1600 && imageSize.height <= 1200;
  const mime = losslessCrop ? "image/png" : "image/jpeg";
  const bytes = losslessCrop ? image.toPNG() : image.toJPEG(90);
  const imageUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  return { imageUrl, fullWidth, fullHeight, originX, originY, imageWidth: imageSize.width, imageHeight: imageSize.height, losslessCrop };
}

export async function executeComputerTool(tool: string, args: unknown): Promise<ComputerToolResponse> {
  if (tool !== COMPUTER_TOOL_NAME) {
    return { contentItems: [{ type: "inputText", text: `Unsupported dynamic tool: ${tool}` }], success: false };
  }
  try {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("Computer tool arguments must be an object.");
    }
    const message = await performAction(args as JsonRecord);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const record = args as JsonRecord;
    const screenshot = await capturePrimaryDisplay(record);
    const region = screenshot.originX === 0 && screenshot.originY === 0 &&
      screenshot.imageWidth === screenshot.fullWidth && screenshot.imageHeight === screenshot.fullHeight
      ? "full screen"
      : `crop origin (${screenshot.originX}, ${screenshot.originY}), size ${screenshot.imageWidth}x${screenshot.imageHeight}${screenshot.losslessCrop ? ", lossless PNG" : ""}`;
    return {
      contentItems: [
        {
          type: "inputText",
          text: `${message} Returned ${region}. Full screen: ${screenshot.fullWidth}x${screenshot.fullHeight}. All action coordinates use the full screen.`,
        },
        { type: "inputImage", imageUrl: screenshot.imageUrl },
      ],
      success: true,
    };
  } catch (error) {
    return {
      contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }],
      success: false,
    };
  }
}
