"use client";

import { useEffect, useRef, useState } from "react";
import { Group, Loader, Stack, Text, Textarea, Tooltip } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

import classes from "./MediaNote.module.scss";

/**
 * This viewer's private note on one item (§6, §14b).
 *
 * The last per-user field, and the only one that is not a judgement: a rating says how good
 * the item is and a note says whatever you needed to remember about it — which camera, which
 * holiday, who to ask about the audio. `UserMedia.note` has existed since the schema was
 * written and had no writer until now.
 *
 * **Nobody else can read it**, including an administrator. That is worth a word on screen and
 * a sentence in its tooltip: tags are the library's
 * unless marked private, the rating is shared, and a note that looked like either of those
 * would be the wrong thing to write a reminder in.
 *
 * It is also not searchable, and deliberately (§5c). One shared FTS document cannot carry
 * per-user text without leaking it into another viewer's results, so every per-user field is
 * out of the index and this one is not an exception. Saying so is better than letting
 * somebody discover it by searching for a word they know they typed.
 */

interface MediaNoteProps {
    mediaId: string;
    /** What is stored. The box is seeded from it once; remount with `key` to reseed. */
    note: string | null;
}

/** Matches the column's CHECK constraint and the route's zod cap. */
const NOTE_MAX = 2000;

/**
 * How close to the cap before the count is worth showing.
 *
 * A counter under an empty box is a warning about a limit nobody was going to reach. It
 * appears when the limit stops being theoretical, which for two thousand characters is late.
 */
const COUNT_FROM = NOTE_MAX - 200;

export const MediaNote: React.FC<MediaNoteProps> = ({ mediaId, note }) => {
    const queryClient = useQueryClient();

    const [draft, setDraft] = useState(note ?? "");
    /** What the server last confirmed, so blurring an untouched box writes nothing. */
    const [saved, setSaved] = useState(note ?? "");

    /**
     * The last text sent, so leaving the page right after leaving the box does not send it
     * twice: the blur's save is still in flight, and `saved` has not caught up.
     */
    const sent = useRef<string | null>(note ?? "");

    const mutation = useMutation({
        mutationFn: (text: string) =>
            api<{ note: string | null }>(`/api/media/${mediaId}/user`, {
                method: "PATCH",
                body: JSON.stringify({ note: text }),
            }),
        onSuccess: (result) => {
            // The server trims, and stores empty as null. Taking its answer rather than the
            // draft keeps the box agreeing with what the next page load will show.
            setDraft(result.note ?? "");
            setSaved(result.note ?? "");

            /**
             * This item only.
             *
             * Unlike a rating, a note is not a membership test: no filter selects on it, no
             * facet counts it, no shelf is built from it, and it is not in the search index.
             * So the broad `["media"]` stroke the rating control takes would refetch the
             * library, the count and the home shelves to change nothing.
             */
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.detail(mediaId) });
        },
        // Forget what was sent, so leaving the box again retries rather than looking done.
        onError: () => {
            sent.current = null;
        },
    });

    /**
     * Saved when you leave the box, not as you type.
     *
     * A note is written in sentences with pauses in them, so a debounce long enough not to
     * write a PATCH per word is long enough to lose the last one to the next item. Blur is the
     * moment the writing stopped, and clicking anything else on the page produces it.
     */
    const commit = () => {
        if (draft === saved || draft === sent.current) return;

        sent.current = draft;
        mutation.mutate(draft);
    };

    /**
     * ...and when the box goes away with the cursor still in it.
     *
     * The note sits on the viewer, which moves on by itself: a film ends and autoplay goes to
     * the next item, and `n` is ignored while typing but the timer is not. The box is keyed by
     * the item, so it unmounts without ever being blurred, and the draft would go with it.
     */
    const latest = useRef({ draft, saved });
    useEffect(() => {
        latest.current = { draft, saved };
    }, [draft, saved]);

    const { mutate } = mutation;
    useEffect(
        () => () => {
            const { draft: text, saved: stored } = latest.current;

            if (text !== stored && text !== sent.current) mutate(text);
        },
        [mutate]
    );

    const remaining = NOTE_MAX - draft.length;

    return (
        <Stack gap={4}>
            {/* The section's heading says "Note"; this line says whose, in the words and at
                the height of the tag boxes beside it, so the fields start on one line. */}
            <Group gap={6} align="center" wrap="nowrap">
                {/* One word, as `ScopeLabel` has it on the keyword boxes, with the meaning in
                    the tooltip. A "private to you" badge after "Private" said it twice, and was
                    the only line of the row dressed differently from the rest. */}
                <Tooltip
                    label="Only you can see this, and it is not searchable."
                    withinPortal
                    multiline
                    w={220}
                >
                    <Text size="sm" fw={500}>
                        Private
                    </Text>
                </Tooltip>
                {mutation.isPending && <Loader size={12} color="brass" />}
            </Group>

            <Textarea
                classNames={{ input: classes.input }}
                value={draft}
                autosize
                minRows={3}
                maxRows={12}
                maxLength={NOTE_MAX}
                placeholder="Anything you want to remember about this…"
                aria-label="Your private note on this item"
                onChange={(event) => setDraft(event.currentTarget.value)}
                onBlur={commit}
                error={mutation.isError ? "Could not save" : undefined}
            />

            {/* Absent until the limit is real, rather than greyed out or always present. */}
            {draft.length >= COUNT_FROM && (
                <Text size="xs" c={remaining === 0 ? "oxblood.4" : "dimmed"}>
                    {remaining === 0
                        ? "That is as long as a note can be."
                        : `${remaining} characters left.`}
                </Text>
            )}
        </Stack>
    );
};
