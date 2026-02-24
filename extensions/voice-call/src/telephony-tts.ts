import type { VoiceCallTtsConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { convertPcmToMulaw8k } from "./telephony-audio.js";

export type TelephonyTtsRuntime = {
  textToSpeechTelephony: (params: {
    text: string;
    cfg: CoreConfig;
    prefsPath?: string;
  }) => Promise<{
    success: boolean;
    audioBuffer?: Buffer;
    sampleRate?: number;
    provider?: string;
    error?: string;
  }>;
};

export type TelephonyTtsProvider = {
  synthesizeForTelephony: (text: string) => Promise<Buffer>;
};

const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function createTelephonyTtsProvider(params: {
  coreConfig: CoreConfig;
  ttsOverride?: VoiceCallTtsConfig;
  runtime: TelephonyTtsRuntime;
}): TelephonyTtsProvider {
  const { coreConfig, ttsOverride, runtime } = params;
  const mergedConfig = applyTtsOverride(coreConfig, ttsOverride);

  return {
    synthesizeForTelephony: async (text: string) => {
      const fs = require("fs");
      const LOCAL_TTS_URL = "http://mac-mini.tailcd0984.ts.net:8179/synthesize";

      // Try local Mac Mini Kokoro TTS first (fastest, ~150-300ms)
      try {
        const t0 = Date.now();
        fs.appendFileSync(
          "/tmp/voice-debug.log",
          `${new Date().toISOString()} [TTS] Trying local Kokoro TTS...\n`,
        );
        const response = await fetch(LOCAL_TTS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice: "am_adam" }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          throw new Error(`Local TTS error: ${response.status}`);
        }
        const arrayBuf = await response.arrayBuffer();
        const wavBuffer = Buffer.from(arrayBuf);
        const genTime = response.headers.get("X-Generation-Time") || "?";
        const t1 = Date.now();
        fs.appendFileSync(
          "/tmp/voice-debug.log",
          `${new Date().toISOString()} [TTS] Local Kokoro: ${wavBuffer.length} bytes, gen=${genTime}s, total=${t1 - t0}ms\n`,
        );
        // WAV has 44-byte header, then 16-bit PCM at 24kHz
        const pcmBuffer = wavBuffer.subarray(44);
        return convertPcmToMulaw8k(pcmBuffer, 24000);
      } catch (err: any) {
        fs.appendFileSync(
          "/tmp/voice-debug.log",
          `${new Date().toISOString()} [TTS] Local Kokoro failed: ${err.message}, falling back to OpenAI\n`,
        );
      }

      // Fallback: OpenAI TTS (slower but reliable)
      const openaiKey =
        mergedConfig?.messages?.tts?.openai?.apiKey ||
        (mergedConfig as any)?.streaming?.openaiApiKey ||
        process.env.OPENAI_API_KEY;
      const voice = mergedConfig?.messages?.tts?.openai?.voice || "onyx";

      if (openaiKey) {
        fs.appendFileSync(
          "/tmp/voice-debug.log",
          `${new Date().toISOString()} [TTS] Falling back to OpenAI TTS, voice=${voice}\n`,
        );
        try {
          const t0 = Date.now();
          const response = await fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${openaiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "tts-1",
              input: text,
              voice: voice,
              response_format: "pcm",
              speed: 1.0,
            }),
          });
          if (!response.ok) {
            throw new Error(`OpenAI TTS error: ${response.status}`);
          }
          const arrayBuf = await response.arrayBuffer();
          const pcmBuffer = Buffer.from(arrayBuf);
          const t1 = Date.now();
          fs.appendFileSync(
            "/tmp/voice-debug.log",
            `${new Date().toISOString()} [TTS] OpenAI: ${pcmBuffer.length} bytes, total=${t1 - t0}ms\n`,
          );
          return convertPcmToMulaw8k(pcmBuffer, 24000);
        } catch (err: any) {
          fs.appendFileSync(
            "/tmp/voice-debug.log",
            `${new Date().toISOString()} [TTS] OpenAI failed: ${err.message}\n`,
          );
        }
      }

      // Fallback to core TTS
      const result = await runtime.textToSpeechTelephony({
        text,
        cfg: mergedConfig,
      });

      if (!result.success || !result.audioBuffer || !result.sampleRate) {
        throw new Error(result.error ?? "TTS conversion failed");
      }

      return convertPcmToMulaw8k(result.audioBuffer, result.sampleRate);
    },
  };
}

function applyTtsOverride(coreConfig: CoreConfig, override?: VoiceCallTtsConfig): CoreConfig {
  if (!override) {
    return coreConfig;
  }

  const base = coreConfig.messages?.tts;
  const merged = mergeTtsConfig(base, override);
  if (!merged) {
    return coreConfig;
  }

  return {
    ...coreConfig,
    messages: {
      ...coreConfig.messages,
      tts: merged,
    },
  };
}

function mergeTtsConfig(
  base?: VoiceCallTtsConfig,
  override?: VoiceCallTtsConfig,
): VoiceCallTtsConfig | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!override) {
    return base;
  }
  if (!base) {
    return override;
  }
  return deepMerge(base, override);
}

function deepMerge<T>(base: T, override: T): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (BLOCKED_MERGE_KEYS.has(key) || value === undefined) {
      continue;
    }
    const existing = (base as Record<string, unknown>)[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
