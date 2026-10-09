import { Badge, Button, Checkbox, Group, Loader, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { OcrMatchCandidate, OcrMatchTagKind, OcrQueueItem } from "@private-stock/core";

import { facetLabel } from "@/lib/facetLabels";
import { formatTimecode } from "@/lib/timecode";

import { Highlighted, MatchItems, OtherTag, plural, shortDay } from "./OcrMatchParts";
import { OcrThumb } from "./OcrThumb";
import classes from "./OcrReview.module.scss";

interface OcrQueueRowProps {
    item: OcrQueueItem;
    focused: boolean;
    onFocus: () => void;
    /** Pairs the reviewer has unticked; every other pair is ticked. */
    unticked: Set<string>;
    onTick: (matchId: string, ticked: boolean) => void;
    /** Other items left out of an accept. */
    excluded: Set<string>;
    onExclude: (mediaId: string, excluded: boolean) => void;
    onAccept: () => void;
    onSkip: () => void;
    onNever: () => void;
    /** File one of the item's strings under another tag, in place of `replace` when given. */
    onManual: (textNorm: string, kind: OcrMatchTagKind, name: string, replace?: string) => void;
    busy: boolean;
    /** The string whose items are listed, if any. */
    openString: string | null;
    onToggleOpen: (textNorm: string) => void;
}

/** Every pair the row offers, across its strings. */
export const candidatesOf = (item: OcrQueueItem): OcrMatchCandidate[] =>
    item.strings.flatMap((string) => string.candidates);

/**
 * One item whose text names a performer or source (§5d "The queue is items").
 *
 * The frame the text was read from, each string with what named somebody picked out, and a chip
 * per name saying how many items it tags: this one, and the others showing the same text.
 * Tagging makes the pair a rule, so the items it is read on later are tagged without asking.
 */
export const OcrQueueRow: React.FC<OcrQueueRowProps> = ({
    item,
    focused,
    onFocus,
    unticked,
    onTick,
    excluded,
    onExclude,
    onAccept,
    onSkip,
    onNever,
    onManual,
    busy,
    openString,
    onToggleOpen,
}) => {
    const isPhone = useMediaQuery("(max-width: 48em)");
    const ticked = candidatesOf(item).filter((candidate) => !unticked.has(candidate.matchId));
    const owed = ticked.reduce((sum, candidate) => sum + candidate.untagged, 0);
    const lead = item.strings[0];
    const buttonSize = isPhone ? "md" : "compact-sm";

    return (
        <div className={classes.matchRow} data-focused={focused} onClick={onFocus}>
            {lead ? (
                <OcrThumb
                    mediaId={item.mediaId}
                    frame={lead.frame}
                    coverUrl={item.coverUrl}
                    box={lead.box}
                    atMs={lead.atMs}
                    width={isPhone ? 280 : 168}
                    label={item.fileName}
                />
            ) : (
                <span />
            )}

            <div style={{ minWidth: 0 }}>
                <div className={classes.head}>
                    <Text component="span" className={classes.itemTitle}>
                        {item.fileName}
                    </Text>
                    <Badge
                        size="sm"
                        variant="light"
                        color={item.newName ? "brass" : "gray"}
                        className={classes.badge}
                    >
                        {item.newName ? "New name" : "New item"}
                    </Badge>
                    <Text component="span" className={classes.stats}>
                        {shortDay(item.matchedAt)}
                    </Text>
                    {busy && <Loader size="xs" />}
                </div>
                {item.title !== item.fileName && (
                    <Text className={classes.fileName}>{item.title}</Text>
                )}

                {item.strings.map((string) => {
                    const others = string.candidates.some((candidate) => candidate.untagged > 1);

                    return (
                        <div key={string.textNorm} className={classes.queueString}>
                            <div className={classes.head}>
                                <Text component="span" className={classes.string}>
                                    <Highlighted
                                        text={string.text}
                                        spans={string.candidates.map(
                                            (candidate) => candidate.matchedText
                                        )}
                                    />
                                </Text>
                                {string.atMs !== null && item.kind === "video" && (
                                    <Text component="span" className={classes.stats}>
                                        at {formatTimecode(string.atMs)}
                                    </Text>
                                )}
                            </div>

                            <div className={classes.candidates}>
                                {string.candidates.map((candidate) => (
                                    <label key={candidate.matchId} className={classes.candidate}>
                                        <Checkbox
                                            size="sm"
                                            color="brass"
                                            checked={!unticked.has(candidate.matchId)}
                                            onChange={(event) =>
                                                onTick(
                                                    candidate.matchId,
                                                    event.currentTarget.checked
                                                )
                                            }
                                            onClick={(event) => event.stopPropagation()}
                                            aria-label={`Include ${candidate.tagName}`}
                                        />
                                        <span style={{ minWidth: 0 }}>
                                            <Text
                                                size="sm"
                                                fw={500}
                                                className={classes.candidateName}
                                            >
                                                {candidate.tagName}
                                            </Text>
                                            <Text className={classes.stats}>
                                                {facetLabel(candidate.tagKind)}
                                                {candidate.untagged > 1 &&
                                                    ` · this + ${plural(candidate.untagged - 1, "other", "others")}`}
                                                {candidate.kind === "manual" && " · chosen by hand"}
                                            </Text>
                                            {candidate.correctedText && (
                                                <Text className={classes.stats}>
                                                    Misread · corrects to “{candidate.correctedText}
                                                    ”
                                                </Text>
                                            )}
                                        </span>
                                    </label>
                                ))}
                            </div>

                            <Group gap="xs" mt={6} wrap="wrap">
                                <OtherTag
                                    disabled={busy}
                                    onPick={(kind, name) =>
                                        onManual(
                                            string.textNorm,
                                            kind,
                                            name,
                                            string.candidates.length === 1
                                                ? string.candidates[0].matchId
                                                : undefined
                                        )
                                    }
                                />
                                {others && (
                                    <Button
                                        variant="subtle"
                                        size="compact-sm"
                                        color="gray"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            onToggleOpen(string.textNorm);
                                        }}
                                        aria-expanded={openString === string.textNorm}
                                    >
                                        {openString === string.textNorm
                                            ? "Hide the others"
                                            : "Check the others"}
                                    </Button>
                                )}
                            </Group>

                            {openString === string.textNorm && (
                                <MatchItems
                                    textNorm={string.textNorm}
                                    candidates={string.candidates}
                                    ticked={ticked.filter((candidate) =>
                                        string.candidates.includes(candidate)
                                    )}
                                    excluded={excluded}
                                    onExclude={onExclude}
                                    ownMediaId={item.mediaId}
                                />
                            )}
                        </div>
                    );
                })}

                {ticked.length > 0 && (
                    <Group gap="xs" mt="sm" wrap="wrap">
                        <Button
                            size={buttonSize}
                            color="brass"
                            disabled={busy}
                            onClick={(event) => {
                                event.stopPropagation();
                                onAccept();
                            }}
                        >
                            {excluded.size === 0 ? `Tag ${plural(owed, "item", "items")}` : "Tag"}
                        </Button>
                        <Button
                            size={buttonSize}
                            variant="default"
                            disabled={busy}
                            onClick={(event) => {
                                event.stopPropagation();
                                onSkip();
                            }}
                        >
                            Not on this one
                        </Button>
                        <Button
                            size={buttonSize}
                            variant="subtle"
                            color="oxblood"
                            disabled={busy}
                            onClick={(event) => {
                                event.stopPropagation();
                                onNever();
                            }}
                        >
                            Never for this text
                        </Button>
                    </Group>
                )}
            </div>
        </div>
    );
};
