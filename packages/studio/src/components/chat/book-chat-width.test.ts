import { describe, expect, it } from "vitest";
import {
  BOOK_CHAT_WIDTH_KEY,
  CHAT_MAX,
  CHAT_MIN,
  clampChatWidth,
  getChatDefaultWidth,
  parseStoredChatWidth,
  readChatWidth,
  writeChatWidth,
} from "./book-chat-width";

describe("book chat width memory", () => {
  it("defaults to 320 under 1440, 360 at/above 1440, and 420 at/above 1680", () => {
    expect(getChatDefaultWidth(1280)).toBe(320);
    expect(getChatDefaultWidth(1439)).toBe(320);
    expect(getChatDefaultWidth(1440)).toBe(360);
    expect(getChatDefaultWidth(1679)).toBe(360);
    expect(getChatDefaultWidth(1680)).toBe(420);
    expect(getChatDefaultWidth(1920)).toBe(420);
  });

  it("clamps drag width to 300–480", () => {
    expect(clampChatWidth(299)).toBe(CHAT_MIN);
    expect(clampChatWidth(300)).toBe(300);
    expect(clampChatWidth(480)).toBe(480);
    expect(clampChatWidth(481)).toBe(CHAT_MAX);
    expect(clampChatWidth(Number.NaN)).toBe(320);
  });

  it("reads a remembered width from localStorage", () => {
    const storage = new Map<string, string>([[BOOK_CHAT_WIDTH_KEY, "400"]]);
    expect(readChatWidth({ getItem: (key) => storage.get(key) ?? null }, 1280)).toBe(400);
  });

  it("ignores out-of-range stored values and falls back to the viewport default", () => {
    expect(parseStoredChatWidth("200")).toBeNull();
    expect(parseStoredChatWidth("500")).toBeNull();
    expect(parseStoredChatWidth("nope")).toBeNull();
    const storage = new Map<string, string>([[BOOK_CHAT_WIDTH_KEY, "999"]]);
    expect(readChatWidth({ getItem: (key) => storage.get(key) ?? null }, 1440)).toBe(360);
  });

  it("persists the clamped width", () => {
    const storage = new Map<string, string>();
    writeChatWidth({ setItem: (key, value) => { storage.set(key, value); } }, 512);
    expect(storage.get(BOOK_CHAT_WIDTH_KEY)).toBe("480");
  });
});
