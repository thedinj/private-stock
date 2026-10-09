import { useState } from "react";
import { Button, Checkbox, Loader, Popover, SegmentedControl, Stack, Text } from "@mantine/core";

import type { OcrMatchCandidate, OcrMatchTagKind } from "@private-stock/core";

import { TagNameInput } from "@/components/tags/TagNameInput";
import { useOcrMatchItems } from "@/lib/api/ocr";
import { facetLabel } from "@/lib/facetLabels";

import { OcrThumb } from "./OcrThumb";
import classes from "./OcrReview.module.scss";

/**
 * What the OCR lists' rows share (§5d "Tagging performers and sources from what was read"): the
 * string with what named somebody picked out, filing it under another name, and the items a
 * string was read on.
 */

export const plural = (count: number, one: string, many: string): string =>
    `${count.toLocaleString()} ${count === 1 ? one : many}`;

/**
 * A database timestamp as a short day. SQLite's `CURRENT_TIMESTAMP` is UTC with no zone, which a
 * browser would read as local time.
 */
export const shortDay = (value: string): string =>
    new Date(`${value.replace(" ", "T")}Z`).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
    });

/** The string with the parts that named a tag picked out. */
export const Highlighted: React.FC<{ text: string; spans: string[] }> = ({ text, spans }) => {
    const parts: React.ReactNode[] = [];
    const wanted = [...new Set(spans)].filter((span) => span && text.includes(span));
    let rest = text;
    let key = 0;

    while (rest) {
        const next = wanted
            .map((span) => ({ span, at: rest.indexOf(span) }))
            .filter(({ at }) => at >= 0)
            .sort((a, b) => a.at - b.at || b.span.length - a.span.length)[0];

        if (!next) {
            parts.push(rest);
            break;
        }

        parts.push(rest.slice(0, next.at));
        parts.push(
            <mark key={key++} className={classes.matched}>
                {next.span}
            </mark>
        );
        rest = rest.slice(next.at + next.span.length);
    }

    return <>{parts}</>;
};

/** Another performer or source for this string: one name, from the vocabulary or new. */
export const OtherTag: React.FC<{
    onPick: (kind: OcrMatchTagKind, name: string) => void;
    disabled: boolean;
}> = ({ onPick, disabled }) => {
    const [opened, setOpened] = useState(false);
    const [kind, setKind] = useState<OcrMatchTagKind>("performer");
    const [names, setNames] = useState<string[]>([]);

    const pick = (): void => {
        const name = names[0]?.trim();

        if (name) {
            onPick(kind, name);
            setNames([]);
            setOpened(false);
        }
    };

    return (
        <Popover opened={opened} onChange={setOpened} position="bottom-end" withArrow trapFocus>
            <Popover.Target>
                <Button
                    variant="subtle"
                    color="gray"
                    size="compact-sm"
                    disabled={disabled}
                    onClick={(event) => {
                        event.stopPropagation();
                        setOpened((current) => !current);
                    }}
                >
                    Other tag…
                </Button>
            </Popover.Target>
            <Popover.Dropdown onKeyDown={(event) => event.stopPropagation()}>
                <Stack gap="xs" w={260}>
                    <SegmentedControl
                        size="xs"
                        value={kind}
                        onChange={(value) => setKind(value as OcrMatchTagKind)}
                        data={[
                            { value: "performer", label: facetLabel("performer") },
                            { value: "source", label: facetLabel("source") },
                        ]}
                    />
                    <TagNameInput
                        kind={kind}
                        scope="public"
                        value={names}
                        onChange={(next) => setNames(next.slice(-1))}
                        maxTags={1}
                        placeholder="Name"
                        aria-label={`${facetLabel(kind)} name`}
                    />
                    <Button size="xs" color="brass" disabled={names.length === 0} onClick={pick}>
                        Propose
                    </Button>
                    <Text size="xs" c="dimmed">
                        Added as a proposal with its own count, to tag like the others.
                    </Text>
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};

/**
 * The items a string was read on, each saying whether accepting would tag it. Unticking one
 * leaves it out of the accept, and the rule never tags it afterwards. The row's own item is
 * listed without a tick: it is the one being decided about.
 */
export const MatchItems: React.FC<{
    textNorm: string;
    /** Every pair of the string, for what each item already carries. */
    candidates: OcrMatchCandidate[];
    /** The pairs an accept would apply. */
    ticked: OcrMatchCandidate[];
    excluded: Set<string>;
    onExclude: (mediaId: string, excluded: boolean) => void;
    ownMediaId?: string;
}> = ({ textNorm, candidates, ticked, excluded, onExclude, ownMediaId }) => {
    const items = useOcrMatchItems(textNorm);
    const list = items.data?.pages.flatMap((page) => page.items) ?? [];

    if (items.isPending) {
        return <Loader size="xs" mt="sm" />;
    }

    return (
        <div className={classes.itemList}>
            {list.map((item) => {
                const owed = ticked.filter(
                    (candidate) =>
                        !item.taggedWith.includes(candidate.tagId) &&
                        !item.skippedFrom.includes(candidate.matchId)
                );
                const has = candidates.filter((candidate) =>
                    item.taggedWith.includes(candidate.tagId)
                );

                return (
                    <div key={item.mediaId} className={classes.item}>
                        <OcrThumb
                            mediaId={item.mediaId}
                            frame={item.frame}
                            coverUrl={item.coverUrl}
                            box={item.box}
                            atMs={item.atMs}
                            width={120}
                            label={item.fileName}
                        />
                        <div style={{ minWidth: 0 }}>
                            <Text className={classes.itemTitle}>{item.fileName}</Text>
                            {item.title !== item.fileName && (
                                <Text className={classes.fileName}>{item.title}</Text>
                            )}
                            {has.length > 0 && (
                                <Text className={classes.stats}>
                                    Has {has.map((candidate) => candidate.tagName).join(", ")}
                                </Text>
                            )}
                            {item.mediaId === ownMediaId ? (
                                <Text className={classes.stats}>This item</Text>
                            ) : (
                                owed.length > 0 && (
                                    <Checkbox
                                        mt={6}
                                        size="sm"
                                        color="brass"
                                        label={`Tag ${owed.map((candidate) => candidate.tagName).join(", ")}`}
                                        checked={!excluded.has(item.mediaId)}
                                        onChange={(event) =>
                                            onExclude(item.mediaId, !event.currentTarget.checked)
                                        }
                                    />
                                )
                            )}
                        </div>
                    </div>
                );
            })}

            {items.hasNextPage && (
                <Button
                    variant="subtle"
                    size="xs"
                    loading={items.isFetchingNextPage}
                    onClick={() => void items.fetchNextPage()}
                    style={{ alignSelf: "flex-start" }}
                >
                    More items
                </Button>
            )}
        </div>
    );
};
