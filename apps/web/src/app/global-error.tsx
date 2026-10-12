"use client";

/**
 * Last-resort error boundary.
 *
 * Catches failures in the root layout itself, which `error.tsx` cannot — the root layout is
 * what renders that boundary. Because it replaces the whole document, it must supply its own
 * `<html>` and `<body>`, and it cannot rely on Mantine: if the provider is what broke, using
 * its components here would fail a second time inside the handler for the first failure.
 *
 * So this is deliberately plain inline-styled markup with no imports beyond React.
 */
const GlobalError: React.FC<{ error: Error & { digest?: string }; reset: () => void }> = ({
    error,
    reset,
}) => (
    <html lang="en">
        <body
            style={{
                margin: 0,
                minHeight: "100dvh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#0f0d0b",
                color: "#ece4d7",
                fontFamily: "system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
                padding: "1rem",
            }}
        >
            <div style={{ maxWidth: 440, textAlign: "center" }}>
                <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>Something broke</h1>
                <p style={{ fontSize: "0.875rem", opacity: 0.7, lineHeight: 1.5 }}>
                    The application failed to render. Reloading may be enough; if not, the server
                    log will have the detail.
                </p>
                {error.digest && (
                    <p style={{ fontSize: "0.75rem", opacity: 0.5, fontFamily: "monospace" }}>
                        {error.digest}
                    </p>
                )}
                <button
                    type="button"
                    onClick={reset}
                    style={{
                        marginTop: "1rem",
                        padding: "0.5rem 1rem",
                        minHeight: 44,
                        background: "transparent",
                        border: "1px solid rgba(228, 185, 85, 0.45)",
                        borderRadius: 4,
                        color: "#e4b955",
                        cursor: "pointer",
                        font: "inherit",
                    }}
                >
                    Try again
                </button>
            </div>
        </body>
    </html>
);

export default GlobalError;
