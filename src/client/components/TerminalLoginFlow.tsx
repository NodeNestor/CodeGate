import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, AlertTriangle, CheckCircle, Loader2, ExternalLink } from "lucide-react";
import {
  createSession,
  deleteSession,
  importCredentials,
  checkSessionCredentials,
  getSessionAuthUrls,
} from "../lib/api";
import { getProviderLabel } from "./ui/Badge";

interface TerminalLoginFlowProps {
  provider: "anthropic" | "openai" | "gemini";
  onSuccess: () => void;
  onBack: () => void;
}

type Status = "creating" | "waiting" | "detected" | "success" | "error";

interface ProviderConfig {
  title: string;
  autoCommand: string;
  instruction: string;
  pasteHint?: string;
  note?: React.ReactNode;
}

function getProviderConfig(provider: TerminalLoginFlowProps["provider"]): ProviderConfig {
  switch (provider) {
    case "anthropic":
      return {
        title: "Log in to Anthropic",
        autoCommand: "claude login",
        instruction: "The login command will run automatically. Complete the OAuth flow in the browser window that opens.",
      };
    case "openai":
      return {
        title: "Log in to OpenAI",
        autoCommand: "codex login --device-auth",
        instruction: "The login command will run automatically. Open the link below, sign in, and enter the device code shown in the terminal.",
        note: (
          <>
            You may need to enable cross-device login in your{" "}
            <a
              href="https://chatgpt.com/settings"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-blue-300"
            >
              ChatGPT security settings
            </a>
          </>
        ),
      };
    case "gemini":
      return {
        title: "Log in to Google",
        autoCommand: "gcloud auth application-default login",
        instruction: "The login command will run automatically. Sign in via the link below, then paste the authorization code back into the terminal.",
        pasteHint: "Right-click in the terminal to paste the code.",
      };
  }
}

export default function TerminalLoginFlow({
  provider,
  onSuccess,
  onBack,
}: TerminalLoginFlowProps) {
  const [status, setStatus] = useState<Status>("creating");
  const [port, setPort] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [authUrls, setAuthUrls] = useState<string[]>([]);

  const sessionIdRef = useRef<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const successRef = useRef<boolean>(false);
  const openedUrlsRef = useRef<Set<string>>(new Set());

  const config = getProviderConfig(provider);
  const providerLabel = getProviderLabel(provider);
  const accountName = `My ${providerLabel} Account`;

  const stopPolling = () => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const handleImport = async (sessionId: string) => {
    try {
      await importCredentials(sessionId, accountName);
      successRef.current = true;
      setStatus("success");
      setTimeout(() => {
        onSuccess();
      }, 1500);
    } catch (err) {
      setStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to import credentials"
      );
    }
  };

  const handleManualImport = () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    stopPolling();
    setStatus("detected");
    handleImport(sessionId);
  };

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const session = await createSession("login", config.autoCommand);
        if (cancelled) return;

        sessionIdRef.current = session.id;
        setPort(session.port);
        setStatus("waiting");

        // Combined poll: check for auth URLs + credentials every 2s
        pollIntervalRef.current = setInterval(async () => {
          const sessionId = sessionIdRef.current;
          if (!sessionId) return;

          try {
            // Poll for auth URLs — auto-open new ones
            const urlResult = await getSessionAuthUrls(sessionId);
            if (urlResult.urls.length > 0) {
              setAuthUrls(urlResult.urls);
              for (const url of urlResult.urls) {
                if (!openedUrlsRef.current.has(url)) {
                  openedUrlsRef.current.add(url);
                  window.open(url, "_blank");
                }
              }
            }

            // Poll for credentials
            const credResult = await checkSessionCredentials(sessionId);
            if (credResult.found) {
              stopPolling();
              setStatus("detected");
              await handleImport(sessionId);
            }
          } catch {
            // Silently ignore poll errors; keep trying
          }
        }, 2000);
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(
          err instanceof Error ? err.message : "Failed to create session"
        );
      }
    };

    init();

    return () => {
      cancelled = true;
      stopPolling();
      const sessionId = sessionIdRef.current;
      if (sessionId && !successRef.current) {
        deleteSession(sessionId).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderStatusBar = () => {
    switch (status) {
      case "creating":
        return null;
      case "waiting":
        return (
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Waiting for credentials...</span>
          </div>
        );
      case "detected":
        return (
          <div className="flex items-center gap-2 text-blue-400 text-sm">
            <CheckCircle className="w-4 h-4" />
            <span>Credentials detected! Importing...</span>
          </div>
        );
      case "success":
        return (
          <div className="flex items-center gap-2 text-green-400 text-sm">
            <CheckCircle className="w-4 h-4" />
            <span>Connected! Account created.</span>
          </div>
        );
      case "error":
        return (
          <div className="flex items-center gap-2 text-red-400 text-sm">
            <AlertTriangle className="w-4 h-4" />
            <span>{errorMessage || "An error occurred"}</span>
          </div>
        );
    }
  };

  if (status === "creating") {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <h2 className="text-base font-semibold text-gray-100">{config.title}</h2>
      </div>

      {/* Instruction box */}
      <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-300 space-y-1">
        <p>{config.instruction}</p>
        {config.pasteHint && (
          <p className="text-blue-400/70 text-xs">{config.pasteHint}</p>
        )}
        {config.note && (
          <p className="text-blue-400/80">{config.note}</p>
        )}
      </div>

      {/* Auth URL — shown when detected, clickable fallback if popup blocked */}
      {authUrls.length > 0 && status === "waiting" && (
        <div className="rounded-lg border border-brand-500/30 bg-brand-500/10 px-4 py-3">
          <p className="text-xs text-gray-400 mb-1.5">Auth link detected — should have opened automatically:</p>
          {authUrls.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300 transition-colors break-all"
            >
              <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              {url.length > 80 ? url.slice(0, 80) + "..." : url}
            </a>
          ))}
        </div>
      )}

      {/* Status indicator */}
      <div className="min-h-[24px]">{renderStatusBar()}</div>

      {/* Terminal iframe */}
      {port !== null && (
        <iframe
          src={`http://localhost:${port}`}
          title="Login Terminal"
          className="w-full rounded-lg border border-gray-700"
          style={{ height: "400px" }}
        />
      )}

      {/* Manual import fallback */}
      <div className="flex justify-end">
        <button
          onClick={handleManualImport}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          disabled={status === "detected" || status === "success"}
        >
          Import manually
        </button>
      </div>
    </div>
  );
}
