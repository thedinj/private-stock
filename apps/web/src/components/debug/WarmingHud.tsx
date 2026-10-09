"use client";

import { useEffect, useState } from "react";
import { Portal, UnstyledButton } from "@mantine/core";

import { useAuth } from "@/lib/api/AuthProvider";
import { deviceWarmingRefusal } from "@/lib/videoWarming";
import {
    covers,
    currentIntent,
    describeEvents,
    describeJoin,
    formatDuration,
    formatMs,
    listParticipants,
    offTarget,
    rangesOf,
    useJoinHistory,
    useWarmingHudEnabled,
    type JoinRecord,
    type WarmParticipant,
} from "@/lib/warmMonitor";

import classes from "./WarmingHud.module.scss";

/**
 * The warming overlay (§8b, "Seeing it work").
 *
 * One badge, top centre, over everything: the page, a fullscreen player and the tasting stage.
 * Fullscreen needs nothing special, because what goes fullscreen is the document
 * (`usePlayerFullscreen`), so a fixed element in the body is painted there like anywhere else;
 * it only has to sit above the player's own `z-index`.
 *
 * Top centre because every other corner is taken somewhere: the app's burger and wordmark, the
 * tasting's title and its control pill, every player's transport along the bottom.
 *
 * Admins only, and only once switched on in the About dialog's admin tools. It reads what the
 * players report through `warmMonitor` on its own clock rather than being re-rendered by them.
 */

type Tone = "ready" | "pending" | "off" | "miss";

/** How far a parked warm element can sit from its start before that is a miss. */
const PARKED_TOLERANCE_MS = 2_000;

const POLL_MS = 250;

const short = (id: string | null | undefined): string => (id ? `${id.slice(0, 8)}…` : "—");

const isVideo = (element: Element | null): element is HTMLVideoElement =>
    element instanceof HTMLVideoElement;

/** The stage a participant belongs to: the tasting's picture layer is the tasting. */
const stageOf = (participant: WarmParticipant): string => participant.source.replace(/-still$/, "");

/**
 * The next item, when it is cued in a player of its own rather than warmed in this one's
 * second element: a held participant on the same stage (§14g, and the showcase's spotlight,
 * §14f). Without this the live player, which offers nothing itself, read as NO NEXT while its
 * successor sat fully buffered on its in point a tile away.
 */
const cueOf = (
    participant: WarmParticipant,
    all: readonly WarmParticipant[]
): WarmParticipant | null =>
    participant.held
        ? null
        : (all.find(
              (other) =>
                  other !== participant && other.held && stageOf(other) === stageOf(participant)
          ) ?? null);

/** A cued player is parked on its in point, so ready means it can play from where it sits. */
const cueStatus = (cue: WarmParticipant): { tone: Tone; label: string } => {
    const element = cue.live();

    if (!element) {
        return { tone: "pending", label: "CUED · WAITING" };
    }

    const ready = isVideo(element)
        ? !element.seeking &&
          element.readyState >= 3 &&
          covers(rangesOf(element.buffered), element.currentTime * 1000)
        : element.complete && element.naturalWidth > 0;

    return ready
        ? { tone: "ready", label: "CUED · READY" }
        : { tone: "pending", label: "CUED · LOADING" };
};

/** What one participant's next item looks like right now, in a word and a colour. */
const statusOf = (
    participant: WarmParticipant,
    all: readonly WarmParticipant[]
): { tone: Tone; label: string } => {
    const cue = participant.gate === "none" ? cueOf(participant, all) : null;

    if (cue) {
        return cueStatus(cue);
    }

    switch (participant.gate) {
        case "refused":
            return { tone: "off", label: "OFF · device" };
        case "none":
            // The spotlight chooses its next tile a few seconds before the end, where it can
            // still say where the wall will be; until then there is nothing to warm yet.
            return participant.source === "showcase"
                ? { tone: "pending", label: "NEXT NOT CHOSEN YET" }
                : { tone: "off", label: "NO NEXT" };
        case "same-file":
            return { tone: "off", label: "SAME FILE" };
        case "waiting":
            return { tone: "pending", label: "WAITING" };
        case "warming":
            break;
    }

    const element = participant.warming();

    if (!element) {
        return { tone: "pending", label: "WAITING" };
    }

    if (!isVideo(element)) {
        return element.complete && element.naturalWidth > 0
            ? { tone: "ready", label: "READY" }
            : { tone: "pending", label: "LOADING" };
    }

    const target = participant.offered?.startMs ?? 0;

    if (covers(rangesOf(element.buffered), target) && element.readyState >= 3) {
        return { tone: "ready", label: "READY" };
    }

    /**
     * Parked somewhere other than where playback will start, and not on its way there. The
     * failure §8b warns looks exactly like success from anywhere else: bandwidth spent, and the
     * join stalls anyway.
     */
    if (
        element.readyState >= 1 &&
        !element.seeking &&
        Math.abs(element.currentTime * 1000 - target) > PARKED_TOLERANCE_MS
    ) {
        return { tone: "miss", label: "MISS · wrong offset" };
    }

    return { tone: "pending", label: "LOADING" };
};

/**
 * A warmed join that was slower than this to start moving is a failure, not a slow success:
 * the whole point of the warm is that the swap plays at once.
 */
const SLOW_START_MS = 500;

/** Whether the element ran dry after arriving: the stall a warm is meant to prevent. */
const starved = (join: JoinRecord): boolean =>
    join.events.some((event) => event.name === "waiting" || event.name === "stalled");

const joinTone = (join: JoinRecord): Tone => {
    if (join.outcome === "gave-up" || offTarget(join)) return "miss";
    if (join.outcome === "left") return "off";
    if (join.kind === "cold" || !join.covered) return "pending";
    if (starved(join) || (join.playingMs !== null && join.playingMs > SLOW_START_MS)) {
        return "miss";
    }

    return "ready";
};

const rangesText = (element: HTMLVideoElement): string => {
    const ranges = rangesOf(element.buffered);

    if (ranges.length === 0) return "nothing";

    const shown = ranges
        .slice(0, 3)
        .map(([start, end]) => `${formatMs(start)}–${formatMs(end)}`)
        .join(", ");

    return ranges.length > 3 ? `${shown} (+${ranges.length - 3})` : shown;
};

/** How much is buffered past a point, in the range that contains it. */
const aheadOf = (element: HTMLVideoElement, atMs: number): number => {
    const range = rangesOf(element.buffered).find(([start, end]) => start <= atMs && atMs <= end);

    return range ? range[1] - atMs : 0;
};

interface ElementLineProps {
    label: string;
    element: Element | null;
    /** Measure what is buffered past this point, and call it this. */
    from?: { atMs: number; label: string };
}

const ElementLine: React.FC<ElementLineProps> = ({ label, element, from }) => {
    if (!element) {
        return (
            <div className={classes.line}>
                <span className={classes.key}>{label}</span> none
            </div>
        );
    }

    if (element instanceof HTMLImageElement) {
        const image = element;

        return (
            <div className={classes.line}>
                <span className={classes.key}>{label}</span>{" "}
                {image.complete && image.naturalWidth > 0 ? "decoded" : "loading"}
                {image.naturalWidth > 0 && ` · ${image.naturalWidth}×${image.naturalHeight}`}
            </div>
        );
    }

    if (!isVideo(element)) {
        return null;
    }

    const at = element.currentTime * 1000;

    return (
        <div className={classes.line}>
            <span className={classes.key}>{label}</span> rs {element.readyState} · ns{" "}
            {element.networkState} · at {formatMs(at)}
            {element.seeking && " (seeking)"}
            {from && ` · ${formatDuration(aheadOf(element, from.atMs))} ${from.label}`}
            <br />
            <span className={classes.key}>buffered</span> {rangesText(element)}
        </div>
    );
};

const ParticipantBlock: React.FC<{
    participant: WarmParticipant;
    all: readonly WarmParticipant[];
    primary: boolean;
}> = ({ participant, all, primary }) => {
    const status = statusOf(participant, all);
    const cue = participant.gate === "none" ? cueOf(participant, all) : null;
    const intent =
        participant.source === "viewer" || participant.source === "still" ? currentIntent() : null;
    const live = participant.live();

    return (
        <section className={classes.block} data-primary={primary || undefined}>
            <header className={classes.blockHead}>
                <span className={classes.dot} data-tone={status.tone} />
                <strong>{participant.source}</strong>
                <span className={classes.dim}>
                    {short(participant.currentId)}
                    {participant.held && " · held"}
                </span>
                <span className={classes.label} data-tone={status.tone}>
                    {status.label}
                </span>
            </header>

            <div className={classes.line}>
                <span className={classes.key}>next</span>{" "}
                {cue ? `${short(cue.currentId)} (cued)` : short(participant.offered?.id)}
                {participant.offered?.startMs != null &&
                    ` @ ${formatMs(participant.offered.startMs)}`}
                <span className={classes.dim}> · gate {participant.gate}</span>
            </div>

            {participant.gate === "none" && intent && (
                <div className={classes.line}>
                    <span className={classes.key}>why</span> {intent.note}
                </div>
            )}

            <ElementLine
                label="warm"
                element={participant.warming()}
                from={{ atMs: participant.offered?.startMs ?? 0, label: "buffered past its start" }}
            />
            <ElementLine
                label="live"
                element={live}
                from={isVideo(live) ? { atMs: live.currentTime * 1000, label: "ahead" } : undefined}
            />
        </section>
    );
};

const JoinRow: React.FC<{ join: JoinRecord }> = ({ join }) => (
    <li className={classes.join}>
        <div className={classes.joinHead}>
            <span className={classes.dot} data-tone={joinTone(join)} />
            <strong>{join.kind.toUpperCase()}</strong>
            <span className={classes.dim}>
                {join.source} {short(join.mediaId)}
                {join.targetMs !== null && ` @${formatMs(join.targetMs)}`}
            </span>
            <span>{join.covered ? "✓" : "✗"}</span>
            {join.aheadMs !== null && (
                <span className={classes.dim}>{formatDuration(join.aheadMs)} ahead</span>
            )}
            <span>
                {join.outcome === "left" && join.readyMs === null
                    ? "left"
                    : join.outcome === "gave-up"
                      ? "no picture"
                      : join.readyMs === null
                        ? "…"
                        : `pic ${formatDuration(join.readyMs)}`}
            </span>
            {join.playingMs !== null && <span>play {formatDuration(join.playingMs)}</span>}
            {offTarget(join) && join.landedMs !== null && (
                <span className={classes.label} data-tone="miss">
                    landed {formatMs(join.landedMs)}
                </span>
            )}
        </div>
        {join.events.length > 0 && (
            <div className={classes.timeline}>{describeEvents(join.events)}</div>
        )}
    </li>
);

export const WarmingHud: React.FC = () => {
    const { hasScope } = useAuth();
    const enabled = useWarmingHudEnabled();
    const joins = useJoinHistory();
    const [open, setOpen] = useState(false);
    const [, setTick] = useState(0);
    const [copied, setCopied] = useState(false);

    const shown = enabled && hasScope("admin");

    // The players report into module state without re-rendering anybody, so this looks on a
    // clock of its own -- only while it is on screen.
    useEffect(() => {
        if (!shown) return;

        const timer = setInterval(() => setTick((tick) => tick + 1), POLL_MS);

        return () => clearInterval(timer);
    }, [shown]);

    if (!shown) {
        return null;
    }

    const participants = listParticipants();
    const lastJoin = joins.at(-1);

    /**
     * The one the badge speaks for: whichever made the latest join, which on a tasting is the
     * layer that just lit; otherwise the first that is not waiting its turn.
     */
    const primaryId =
        participants.find(([id]) => id === lastJoin?.participant)?.[0] ??
        participants.find(([, participant]) => !participant.held)?.[0] ??
        participants[0]?.[0];
    const primary = participants.find(([id]) => id === primaryId)?.[1];
    const everyone = participants.map(([, participant]) => participant);
    const primaryCue = primary ? cueOf(primary, everyone) : null;

    const refusal = deviceWarmingRefusal();
    const status: { tone: Tone; label: string } = primary
        ? statusOf(primary, everyone)
        : { tone: "off", label: "NO PLAYER" };

    const copy = () => {
        const text = joins.map(describeJoin).join("\n");

        void navigator.clipboard
            ?.writeText(text)
            .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1_500);
            })
            .catch(() => undefined);
    };

    return (
        <Portal>
            <div className={classes.hud}>
                <UnstyledButton
                    className={classes.chip}
                    onClick={() => setOpen((value) => !value)}
                    aria-expanded={open}
                    aria-label={`Warming: ${status.label}. ${open ? "Hide" : "Show"} details`}
                >
                    <span className={classes.dot} data-tone={status.tone} />
                    <span className={classes.label} data-tone={status.tone}>
                        {status.label}
                    </span>
                    {(primary?.offered || primaryCue) && (
                        <span className={classes.dim}>
                            next {short(primary?.offered?.id ?? primaryCue?.currentId)}
                        </span>
                    )}
                    {lastJoin && (
                        <span className={classes.dim}>
                            · last {lastJoin.kind.toUpperCase()}
                            {lastJoin.readyMs !== null && ` ${formatDuration(lastJoin.readyMs)}`}
                        </span>
                    )}
                </UnstyledButton>

                {open && (
                    <div className={classes.panel}>
                        <div className={classes.line}>
                            <span className={classes.key}>device</span>{" "}
                            {refusal === null ? "may warm" : `refused, ${refusal}`}
                        </div>

                        {participants.length === 0 && (
                            <div className={classes.line}>No player is reporting.</div>
                        )}

                        {participants.map(([id, participant]) => (
                            <ParticipantBlock
                                key={id}
                                participant={participant}
                                all={everyone}
                                primary={id === primaryId}
                            />
                        ))}

                        <header className={classes.joinsHead}>
                            <strong>Joins</strong>
                            <span className={classes.dim}>newest first</span>
                            <UnstyledButton
                                className={classes.copy}
                                onClick={copy}
                                disabled={joins.length === 0}
                            >
                                {copied ? "Copied" : "Copy"}
                            </UnstyledButton>
                        </header>

                        {joins.length === 0 ? (
                            <div className={classes.line}>None yet. Step to the next item.</div>
                        ) : (
                            <ul className={classes.joins}>
                                {[...joins].reverse().map((join) => (
                                    <JoinRow key={join.id} join={join} />
                                ))}
                            </ul>
                        )}
                    </div>
                )}
            </div>
        </Portal>
    );
};
