"use client";

import { useState } from "react";
import {
    ActionIcon,
    Box,
    Button,
    Divider,
    Drawer,
    Group,
    Stack,
    Switch,
    Text,
    Title,
    Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { MediaDetail, ProvenanceEntry } from "@private-stock/core";

import { OcrFindingLine } from "@/components/ocr/OcrFindingLine";
import { useAuth } from "@/lib/api/AuthProvider";
import { useAddToOcrTestSet } from "@/lib/api/ocr";
import { useRunStage } from "@/lib/api/processing";

import classes from "./MediaDetailsDrawer.module.scss";

/**
 * Everything the page should not volunteer.
 *
 * The detail page used to say all of this out loud, above the fold: a badge row of four
 * identical oak pills, a path, then the tag editor. None of it is what you came for, and
 * presenting it as a row of pills gave the library name, the resolution, the codec and the
 * file size exactly equal weight — which tells you nothing about which of them matters.
 *
 * Behind one control it can afford to be thorough. Nothing was cut to get here; it was moved.
 *
 * **What you read, not what you write.** The tags and the note were here too, below the facts,
 * and they left for the viewer's own page (§14b): they are the fields a person fills in while
 * watching, and a drawer covers the thing being described while you describe it.
 */

const formatBytes = (bytes: number | null): string | null => {
    if (!bytes) return null;

    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const formatDuration = (ms: number | null): string | null => {
    if (!ms || ms <= 0) return null;

    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${minutes}:${String(seconds).padStart(2, "0")}`;
};

/**
 * Rendered by the browser, which knows the reader's zone (§12c).
 *
 * Long form for the facts, short for the ledger: a column of thirty-odd dates wants to be
 * scannable, and the year is the same on all of them.
 */
const formatDay = (value: string | null): string | null =>
    value
        ? new Date(value).toLocaleDateString(undefined, {
              day: "numeric",
              month: "long",
              year: "numeric",
          })
        : null;

const formatShortDay = (value: string | null): string | null =>
    value
        ? new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short" })
        : null;

/**
 * What each stage did, in words rather than in job kinds.
 *
 * The registry's names are the job queue's vocabulary — `filehash`, `phash`, `index` — and
 * they are exactly right there. They are not what a person reading the history of their own
 * file should be shown. A stage with no entry here falls back to its own name, so adding a
 * capability never produces a blank row.
 */
const STAGE_NAMES: Record<string, string> = {
    probe: "Probed",
    filehash: "Hashed",
    cover: "Cover drawn",
    preview: "Preview cut",
    sprite: "Sprite sheet",
    index: "Indexed",
    phash: "Fingerprinted",
    ocr: "OCR",
    embed: "Searchable by look",
    metadata: "File metadata read",
};

const stageLabel = (stage: string): string => STAGE_NAMES[stage] ?? stage;

/**
 * The file's own tags, in the order worth reading them: what it is called and what it says
 * about itself, then who it credits. A key with no entry here is shown under its own name.
 */
const ATTRIBUTE_LABELS: [key: string, label: string][] = [
    ["title", "Title"],
    ["description", "Description"],
    ["comment", "Comment"],
    ["artist", "Artist"],
    ["album", "Album"],
    ["show", "Show"],
];

const attributeOrder = (key: string): number => {
    const at = ATTRIBUTE_LABELS.findIndex(([known]) => known === key);

    return at < 0 ? ATTRIBUTE_LABELS.length : at;
};

const attributeLabel = (key: string): string =>
    ATTRIBUTE_LABELS.find(([known]) => known === key)?.[1] ?? key;

/**
 * "Do this now", drawn rather than written.
 *
 * An arrow returning on itself: the same stage, run again. Deliberately not a play triangle,
 * which everywhere else on this page means the video, and not a plus, which would read as
 * adding a stage rather than running one.
 */
const RunGlyph = () => (
    <svg
        viewBox="0 0 24 24"
        width={14}
        height={14}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <path d="M20 11.5a8 8 0 1 1-2.5-5.8" />
        <path d="M20 4v4.5h-4.5" />
    </svg>
);

const stageWhen = (entry: ProvenanceEntry): string => {
    // Ahead of the outcome, because it is the newer fact: an item being read again still has
    // last time's result, and the row should say that more is coming rather than repeat it.
    if (entry.inFlight === "running") return "running";
    if (entry.inFlight === "queued") return "queued";

    // `pending` means two different things, and calling both of them "queued" promises work
    // that is never coming for the half of them nobody has asked for (§7b). The server
    // decides which this is -- it depends on the admin's settings as well as the stage.
    if (entry.state === "pending") return entry.sweeps ? "queued" : "on request";
    if (entry.state === "failed") return "failed";
    if (entry.state === "empty") return "nothing to do";
    if (entry.state === "skipped") return "skipped";

    return formatShortDay(entry.at) ?? "done";
};

/**
 * ffprobe reports a *family* of formats, not one.
 *
 * `format_name` for an MP4 is the literal string "mov,mp4,m4a,3gp,3g2,mj2" — every container
 * that demuxer handles — and printing it verbatim put the plumbing on the page. Mapped to
 * the name the file actually goes by; anything unrecognised falls through unchanged rather
 * than being hidden.
 */
const CONTAINER_NAMES: Record<string, string> = {
    "mov,mp4,m4a,3gp,3g2,mj2": "MP4",
    matroska: "MKV",
    "matroska,webm": "MKV",
    webm: "WebM",
    "asf,asf_o": "WMV",
    mpegts: "MPEG-TS",
    avi: "AVI",
};

const containerName = (container: string | null): string | null =>
    container ? (CONTAINER_NAMES[container] ?? container.toUpperCase()) : null;

/**
 * "Go to the moment this was read from."
 *
 * A bracket with an arrow leaving it, rather than a play triangle: the point is the position
 * in the file, not starting playback, and the triangle already means the player everywhere
 * else on this page.
 */
const JumpGlyph = () => (
    <svg
        viewBox="0 0 24 24"
        width={14}
        height={14}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <path d="M5 4v16" />
        <path d="M10 12h9" />
        <path d="M15 8l4 4-4 4" />
    </svg>
);

/**
 * How much of the item a string was on, in words.
 *
 * The two numbers say different things and both matter for judging a finding: occurrences is
 * how much evidence there is, stability is how much of the item it covers. A string on nearly
 * every frame is what the file *is* — a channel bug, a site watermark — while one on a
 * handful is something that happened in it. Neither number is rendered as a verdict, because
 * the only person who can tell a watermark from a caption is looking at the library.
 */
const describeReach = (occurrences: number, stability: number): string =>
    `${occurrences} frame${occurrences === 1 ? "" : "s"} · ${Math.round(stability * 100)}% of those read`;

const Row: React.FC<{ label: string; value: string | null }> = ({ label, value }) =>
    value ? (
        <Box className={classes.row}>
            <Text component="span" className={classes.key}>
                {label}
            </Text>
            <Text component="span" className={classes.value}>
                {value}
            </Text>
        </Box>
    ) : null;

interface MediaDetailsDrawerProps {
    detail: MediaDetail;
    opened: boolean;
    onClose: () => void;
    /**
     * Send the player to a moment, and get out of the way.
     *
     * Optional because the panel opens from the grid as well, where there is no player to
     * send anywhere — and a jump control that cannot jump should be absent rather than dead.
     */
    onSeek?: (atMs: number) => void;
    /**
     * Open the page's trash confirmation (`TrashConfirm`), or null when this viewer cannot
     * delete this item -- no `delete` scope, or a read-only root -- and the button is absent.
     */
    onTrash: (() => void) | null;
}

export const MediaDetailsDrawer: React.FC<MediaDetailsDrawerProps> = ({
    detail,
    opened,
    onClose,
    onSeek,
    onTrash,
}) => {
    // Running a stage is an administrator's act (§7b): it is the machine's work, not an
    // opinion about the item, and it costs CPU everybody else is sharing.
    const { hasScope } = useAuth();
    const canRun = hasScope("admin");
    const runStage = useRunStage(detail.id);

    /**
     * Has recognition actually run here?
     *
     * Read from the ledger rather than from whether any findings came back, which is the
     * distinction that matters to somebody wondering where their text is: a stage that ran
     * and found nothing and a stage nobody has asked for look identical if the only evidence
     * is an empty list.
     */
    const ocr = detail.provenance.find((entry) => entry.stage === "ocr");
    const ocrRan = ocr?.state === "done" || ocr?.state === "empty";
    const ocrInFlight = !!ocr?.inFlight;

    /**
     * Dismissed text, for administrators (§5d "Reviewing what was read").
     *
     * Hidden unless asked for, so the panel reads as the item's text rather than as a review
     * queue. A string dismissed here stays on screen until the panel closes, struck through
     * with its undo beside it: the refetch that follows the dismissal must not whisk it away
     * before a mistaken press can be taken back.
     */
    const [showDismissed, setShowDismissed] = useState(false);
    const [dismissedHere, setDismissedHere] = useState<Set<string>>(new Set());
    const [textNote, setTextNote] = useState<{ ok: boolean; message: string } | null>(null);
    const addToBench = useAddToOcrTestSet();

    const addThisToBench = (): void =>
        addToBench.mutate(
            { mediaIds: [detail.id] },
            {
                onSuccess: () =>
                    setTextNote({
                        ok: true,
                        message:
                            "On the OCR test bench. Say what it should read and compare settings on it from Processing › OCR.",
                    }),
                onError: (error) =>
                    setTextNote({
                        ok: false,
                        message: error instanceof Error ? error.message : "It could not be added.",
                    }),
            }
        );
    const dismissedCount = detail.text.filter(
        (finding) => finding.reviewState === "dismissed"
    ).length;
    const shownText = detail.text.filter(
        (finding) =>
            finding.reviewState !== "dismissed" || showDismissed || dismissedHere.has(finding.id)
    );

    /**
     * A sheet on a phone, a panel on a desktop.
     *
     * A 420px panel on a 412px screen is the whole screen with nine pixels of the page
     * showing behind it, which reads as a bug rather than as a drawer.
     */
    const isMobile = useMediaQuery("(max-width: 48em)");

    const dimensions = detail.width && detail.height ? `${detail.width} × ${detail.height}` : null;

    const video =
        [detail.codec, containerName(detail.container)].filter(Boolean).join(" · ") || null;

    /** What the viewer is actually being served, and why (§8). */
    const playbackNote = (): string => {
        switch (detail.playbackSource) {
            case "original":
                return "Plays as it came — no rendition was needed.";
            case "variant":
                return "Played from a web-safe rendition; the original is untouched.";
            case "pending":
                return "A web-safe rendition is still being made.";
            case "unavailable":
                return "Nothing playable is available for this item yet.";
        }
    };

    return (
        <Drawer
            opened={opened}
            onClose={onClose}
            position={isMobile ? "bottom" : "right"}
            size={isMobile ? "88%" : 420}
            // Mantine's header pads 11px on the closing side against a 16px body, so the
            // close button sat 5px outside the column every value in the panel is flushed to.
            styles={{ header: { paddingInlineEnd: "var(--mantine-spacing-md)" } }}
            title={
                <Stack gap={2}>
                    <Text
                        size="xs"
                        c="brass.4"
                        fw={600}
                        style={{ letterSpacing: "0.18em", textTransform: "uppercase" }}
                    >
                        {detail.rootLabel}
                    </Text>
                    {/* Two lines at most: names come straight from filenames and some run to a
                        paragraph. The whole of it is one hover away. */}
                    <Title
                        order={5}
                        lineClamp={2}
                        title={detail.title}
                        style={{ textWrap: "balance", overflowWrap: "anywhere" }}
                    >
                        {detail.title}
                    </Title>
                </Stack>
            }
        >
            <Stack gap="xl" pb="xl">
                <Box className={classes.list}>
                    <Row label="Captured" value={formatDay(detail.capturedAt)} />
                    <Row label="Added" value={formatDay(detail.addedAt)} />
                    {/* A photograph has no length; its probe reports one frame. */}
                    {detail.kind === "video" && (
                        <Row label="Duration" value={formatDuration(detail.durationMs)} />
                    )}
                    <Row label="Dimensions" value={dimensions} />
                    <Row label="Video" value={video} />
                    <Row label="Size" value={formatBytes(detail.sizeBytes)} />
                    <Row label="Path" value={detail.relPath} />
                </Box>

                {/* What the file says about itself (§5b) -- absent when it says nothing, which
                    is most files. Above OCR for OCR's own reason: it is content, and the one
                    place a creator's handle or a site's name is written down as text. */}
                {detail.attributes.length > 0 && (
                    <Box>
                        <Title order={5}>In the file</Title>
                        <Box className={classes.rule} mt={8} mb={12} />
                        <Box className={classes.list}>
                            {[...detail.attributes]
                                .sort((a, b) => attributeOrder(a.key) - attributeOrder(b.key))
                                .map((attribute) => (
                                    <Row
                                        key={attribute.key}
                                        label={attributeLabel(attribute.key)}
                                        value={attribute.value}
                                    />
                                ))}
                        </Box>
                    </Box>
                )}

                {/* The cover used to be chosen here. It is on the page now, under the title,
                    with every frame the item has -- generated or captured -- so choosing it is
                    done where the frames are seen rather than behind a button (§13). */}

                {/* What was read out of the picture (§5d).

                    Shown whenever the stage has run, including when it found nothing —
                    "nothing here" is an answer, and leaving the section out would make a
                    successful empty run indistinguishable from never having asked. Shown
                    too while a pass is on its way, so the place the answer will arrive is
                    visible from the moment somebody asks for it.

                    Above Provenance because it is content rather than history: this is
                    frequently the only trustworthy metadata a file carries, and burying it
                    under the ledger would file the evidence behind the receipt. */}
                {(ocrRan || ocrInFlight || canRun) && (
                    <Box>
                        <Title order={5}>OCR</Title>
                        <Box className={classes.rule} mt={8} mb={12} />

                        {/* Administrators see the section before OCR has run, because the test
                            bench is exactly where a video OCR has never read — or read and
                            missed — belongs, and its button lives here. */}
                        {!ocrRan && !ocrInFlight && (
                            <Text className={classes.note} mb="sm">
                                OCR has not read this one. Run it from Provenance below, or put it
                                on the test bench to try settings on it first.
                            </Text>
                        )}

                        {ocrInFlight && (
                            <Text className={classes.note} mb={ocrRan ? "sm" : 0}>
                                {ocrRan
                                    ? "Reading the frames again. What follows is from the last pass, and will be replaced when this one finishes."
                                    : "Reading the frames now. What it finds will appear here when it finishes — there is no need to reload."}
                            </Text>
                        )}

                        {!ocrRan ? null : shownText.length === 0 && dismissedCount === 0 ? (
                            <Text className={classes.note}>
                                Nothing legible in the frames that were read.
                            </Text>
                        ) : (
                            <>
                                <Text className={classes.note} mb="sm">
                                    Read from the picture, strongest first. These are findings
                                    rather than facts — check one against its frame before trusting
                                    it.
                                    {canRun &&
                                        " Correct or dismiss one here; the decision is kept when the item is read again."}
                                </Text>

                                {shownText.map((finding) => {
                                    // Absent rather than disabled when there is nowhere to go:
                                    // a still has no moment, and the panel can be opened where
                                    // there is no player.
                                    const jump = onSeek && finding.firstAtMs !== null && (
                                        <Tooltip
                                            label={`Go to ${formatDuration(finding.firstAtMs) ?? "the frame"}`}
                                            withArrow
                                        >
                                            <ActionIcon
                                                size="sm"
                                                variant="subtle"
                                                color="gray"
                                                aria-label="Go to the frame this was read from"
                                                onClick={() => {
                                                    onSeek(finding.firstAtMs as number);
                                                    onClose();
                                                }}
                                            >
                                                <JumpGlyph />
                                            </ActionIcon>
                                        </Tooltip>
                                    );

                                    const reach = (
                                        <Text component="span" className={classes.ledgerWhen}>
                                            {describeReach(finding.occurrences, finding.stability)}
                                        </Text>
                                    );

                                    // Reviewing is an administrator's act, as on the review
                                    // page; everybody else reads the text as it stands.
                                    return canRun ? (
                                        <Box key={finding.id} className={classes.ledgerRow}>
                                            <OcrFindingLine
                                                finding={finding}
                                                detail={reach}
                                                trailing={jump}
                                                onError={(message) =>
                                                    setTextNote({ ok: false, message })
                                                }
                                                onChanged={(change) => {
                                                    setTextNote(null);

                                                    if (
                                                        change.kind === "state" &&
                                                        change.reviewState === "dismissed"
                                                    ) {
                                                        setDismissedHere((current) =>
                                                            new Set(current).add(finding.id)
                                                        );
                                                    }
                                                }}
                                            />
                                        </Box>
                                    ) : (
                                        <Box key={finding.id} className={classes.ledgerRow}>
                                            <Text component="span" className={classes.foundText}>
                                                {finding.text}
                                            </Text>
                                            {reach}
                                            {jump}
                                        </Box>
                                    );
                                })}
                            </>
                        )}

                        {textNote && (
                            <Text
                                className={classes.note}
                                c={textNote.ok ? "brass.3" : "oxblood.4"}
                                mt="xs"
                            >
                                {textNote.message}
                            </Text>
                        )}

                        {canRun && (
                            <Group justify="space-between" mt="sm" gap="xs">
                                {dismissedCount > 0 ? (
                                    <Switch
                                        size="xs"
                                        color="brass"
                                        label={`Show ${dismissedCount} dismissed`}
                                        checked={showDismissed}
                                        onChange={(event) =>
                                            setShowDismissed(event.currentTarget.checked)
                                        }
                                    />
                                ) : (
                                    <span />
                                )}
                                <Button
                                    variant="subtle"
                                    size="compact-xs"
                                    color="gray"
                                    loading={addToBench.isPending}
                                    onClick={addThisToBench}
                                >
                                    Add to test bench
                                </Button>
                            </Group>
                        )}
                    </Box>
                )}

                <Box>
                    <Title order={5}>Provenance</Title>
                    <Box className={classes.rule} mt={8} mb={12} />

                    <Text className={classes.note} mb="sm">
                        Found in <strong>{detail.rootLabel}</strong>
                        {formatDay(detail.addedAt) ? (
                            <>
                                {" on "}
                                <strong>{formatDay(detail.addedAt)}</strong>
                            </>
                        ) : null}
                        , and in the house ever since.
                    </Text>

                    {detail.provenance.map((entry) => (
                        <Box key={entry.stage} className={classes.ledgerRow}>
                            <Box
                                className={classes.dot}
                                data-state={entry.state}
                                data-in-flight={entry.inFlight ?? undefined}
                            />
                            <Text component="span" className={classes.ledgerName}>
                                {stageLabel(entry.stage)}
                            </Text>
                            <Text component="span" className={classes.ledgerWhen}>
                                {stageWhen(entry)}
                            </Text>
                            {/* The ledger has always looked like a control panel and been a
                                list. Running a stage for one item is the on-demand half of
                                the pipeline (§7b) and had a route from the day it was
                                written with nothing calling it.

                                Absent rather than disabled when it cannot be run — for a
                                non-administrator, for `probe`, and for a stage that does not
                                apply to this kind of item. A greyed control invites somebody
                                to work out why, and none of those three answers is something
                                they can act on. */}
                            {entry.runnable && canRun && (
                                <Tooltip
                                    label={
                                        entry.state === "pending"
                                            ? `Run ${stageLabel(entry.stage).toLowerCase()} now`
                                            : `Run ${stageLabel(entry.stage).toLowerCase()} again`
                                    }
                                    // A loading control is disabled, and a disabled one fires
                                    // no hover; the word beside it already says why.
                                    disabled={entry.inFlight !== null}
                                    withinPortal
                                >
                                    <ActionIcon
                                        size="sm"
                                        variant="subtle"
                                        color="brass"
                                        className={classes.ledgerRun}
                                        // Spinning for as long as the *work* is outstanding,
                                        // not only while the request that asked for it is --
                                        // that took milliseconds, and left a live button
                                        // beside work that had not started.
                                        loading={
                                            entry.inFlight !== null ||
                                            (runStage.isPending &&
                                                runStage.variables === entry.stage)
                                        }
                                        disabled={runStage.isPending}
                                        aria-label={`Run ${stageLabel(entry.stage)}`}
                                        onClick={() => runStage.mutate(entry.stage)}
                                    >
                                        <RunGlyph />
                                    </ActionIcon>
                                </Tooltip>
                            )}
                        </Box>
                    ))}

                    <Box className={classes.rule} mt={12} mb={12} />
                    <Text className={classes.note}>{playbackNote()}</Text>
                </Box>

                <Divider />

                {/* Last, and well away from anything a thumb lands on by accident: it is the
                    only destructive thing in the panel. The dialog it opens is the page's, the
                    same one the trash icon and the Delete key open. */}
                {onTrash && (
                    <Group justify="flex-end">
                        <Button
                            variant="subtle"
                            color="oxblood"
                            size="sm"
                            onClick={onTrash}
                            aria-keyshortcuts="Delete"
                            style={{ minHeight: 44 }}
                        >
                            Delete
                        </Button>
                    </Group>
                )}
            </Stack>
        </Drawer>
    );
};
