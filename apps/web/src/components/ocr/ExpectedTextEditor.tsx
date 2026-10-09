import { useState } from "react";
import { Button, Group, Stack, Switch, TagsInput, Text } from "@mantine/core";

import type { MediaDetail, OcrBenchItem } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { useSetOcrExpected } from "@/lib/api/ocr";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That could not be saved.";

/**
 * What a nominated video should read (§5d "Tuning against expected text").
 *
 * The ground truth the tuner scores settings against, typed by an administrator. One entry per
 * piece of text as it appears — a banner can be one entry; the scorer matches word by word,
 * so it does not matter that the engine reads it as three.
 *
 * "Complete" is a claim worth making only when it is true: it is what lets the tuner count
 * anything else read as junk. Without it, unexpected text is ignored rather than punished.
 */
export const ExpectedTextEditor: React.FC<{ item: OcrBenchItem }> = ({ item }) => {
    const [expected, setExpected] = useState(item.expected);
    const [complete, setComplete] = useState(item.complete);
    const [copying, setCopying] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const save = useSetOcrExpected();
    const dirty =
        JSON.stringify(expected) !== JSON.stringify(item.expected) || complete !== item.complete;

    /**
     * Start from what review already settled: the strings somebody confirmed or corrected on
     * this item. A convenience — what is saved is still what the administrator leaves here.
     */
    const copyReviewed = async (): Promise<void> => {
        setCopying(true);
        setNote(null);

        try {
            // The item's own details carry its findings, decisions included.
            const detail = await api<MediaDetail>(`/api/media/${encodeURIComponent(item.mediaId)}`);
            const reviewed = detail.text
                .filter(
                    (finding) =>
                        finding.reviewState === "confirmed" || finding.reviewState === "edited"
                )
                .map((finding) => finding.text);

            if (reviewed.length === 0) {
                setNote("Nothing on this item has been confirmed or corrected yet.");
            }

            setExpected((current) => [...new Set([...current, ...reviewed])]);
        } catch (error) {
            setNote(errorText(error));
        } finally {
            setCopying(false);
        }
    };

    return (
        <Stack gap={6}>
            <TagsInput
                label="Should read"
                description="Each piece of text as it appears in the video. Enter after each."
                placeholder={expected.length === 0 ? "e.g. SITE.COM" : undefined}
                value={expected}
                onChange={setExpected}
                maxTags={50}
                splitChars={[]}
                clearable
            />
            <Group gap="sm" wrap="wrap">
                <Switch
                    size="xs"
                    color="brass"
                    label="That is everything legible in it"
                    description="Then anything else read counts as junk"
                    checked={complete}
                    onChange={(event) => setComplete(event.currentTarget.checked)}
                />
                <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    loading={copying}
                    onClick={() => void copyReviewed()}
                >
                    Copy from reviewed strings
                </Button>
                {dirty && (
                    <Button
                        size="compact-xs"
                        color="brass"
                        loading={save.isPending}
                        onClick={() =>
                            save.mutate(
                                { mediaId: item.mediaId, expected, complete },
                                {
                                    onSuccess: () => setNote(null),
                                    onError: (error) => setNote(errorText(error)),
                                }
                            )
                        }
                    >
                        Save
                    </Button>
                )}
            </Group>
            {note && (
                <Text size="xs" c="dimmed">
                    {note}
                </Text>
            )}
        </Stack>
    );
};
