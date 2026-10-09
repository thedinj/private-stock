import { useState } from "react";
import { ActionIcon, Badge, Group, Menu, Text, TextInput, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { OcrChangeResult, OcrReviewState } from "@private-stock/core";

import {
    CheckGlyph,
    MoreGlyph,
    PencilGlyph,
    TrashGlyph,
    UndoGlyph,
} from "@/components/media/Glyph";
import { useOcrEdit, useOcrReview } from "@/lib/api/ocr";
import type { FindingChange } from "@/lib/ocrReview";

import classes from "./OcrReview.module.scss";

/** What a line needs to know about its finding. */
export interface OcrFindingLineFinding {
    id: string;
    text: string;
    reviewState: OcrReviewState | null;
    originalText: string | null;
}

interface OcrFindingLineProps {
    finding: OcrFindingLineFinding;
    /** Called once the server has applied a change. */
    onChanged?: (change: FindingChange) => void;
    onError?: (message: string) => void;
    /** Anything to show after the text, such as how much of the item it was on. */
    detail?: React.ReactNode;
    /** Controls after the review actions, such as a jump to the frame. */
    trailing?: React.ReactNode;
}

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That change could not be saved.";

/**
 * One finding with its review controls (§5d "Reviewing what was read").
 *
 * In the details drawer, where text is corrected: it is read beside the item it came from, which
 * is what tells a misreading from a real string. Acts on the one finding by id.
 *
 * A dismissed finding stays on the line, struck through, with Undo beside it. That is the undo:
 * no toast to catch before it fades, and a mistaken dismissal is put right where it was made.
 */
export const OcrFindingLine: React.FC<OcrFindingLineProps> = ({
    finding,
    onChanged,
    onError,
    detail,
    trailing,
}) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(finding.text);
    const review = useOcrReview();
    const edit = useOcrEdit();
    const isPhone = useMediaQuery("(max-width: 48em)");
    const busy = review.isPending || edit.isPending;
    const dismissed = finding.reviewState === "dismissed";

    const act = (action: "confirm" | "dismiss" | "restore"): void => {
        review.mutate(
            { action, target: { rowIds: [finding.id] } },
            {
                onSuccess: (result: OcrChangeResult) => {
                    if (result.updated === 0) return;

                    onChanged?.({
                        kind: "state",
                        reviewState:
                            action === "restore"
                                ? null
                                : action === "confirm"
                                  ? "confirmed"
                                  : "dismissed",
                        // Restoring a correction puts the engine's reading back.
                        text:
                            action === "restore"
                                ? (finding.originalText ?? finding.text)
                                : finding.text,
                    });
                },
                onError: (error) => onError?.(errorText(error)),
            }
        );
    };

    const save = (): void => {
        const text = draft.trim().replace(/\s+/g, " ");

        if (!text || text === finding.text) {
            setEditing(false);
            return;
        }

        edit.mutate(
            { text, target: { rowIds: [finding.id] } },
            {
                onSuccess: () => {
                    setEditing(false);
                    onChanged?.({
                        kind: "edit",
                        text,
                        // Corrected back to exactly what was read, it is a confirmation —
                        // the rule `mediaTextRepo.editText` applies.
                        reviewState:
                            text === (finding.originalText ?? finding.text)
                                ? "confirmed"
                                : "edited",
                    });
                },
                onError: (error) => onError?.(errorText(error)),
            }
        );
    };

    if (editing) {
        return (
            <Group gap={6} wrap="nowrap" className={classes.findingLine}>
                <TextInput
                    size="xs"
                    value={draft}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") save();
                        if (event.key === "Escape") {
                            setDraft(finding.text);
                            setEditing(false);
                        }
                    }}
                    maxLength={500}
                    autoFocus
                    disabled={busy}
                    aria-label="Corrected text"
                    style={{ flex: 1 }}
                    classNames={{ input: classes.mono }}
                />
                <ActionIcon
                    variant="light"
                    color="brass"
                    size="lg"
                    aria-label="Save the correction"
                    loading={edit.isPending}
                    onClick={save}
                >
                    <CheckGlyph size={16} />
                </ActionIcon>
                <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="lg"
                    aria-label="Cancel"
                    onClick={() => {
                        setDraft(finding.text);
                        setEditing(false);
                    }}
                >
                    <UndoGlyph size={16} />
                </ActionIcon>
            </Group>
        );
    }

    const actions: {
        key: string;
        label: string;
        glyph: React.ReactNode;
        color?: string;
        run: () => void;
    }[] = [
        ...(!dismissed
            ? [
                  {
                      key: "edit",
                      label: "Correct the text",
                      glyph: <PencilGlyph size={15} />,
                      run: () => {
                          setDraft(finding.text);
                          setEditing(true);
                      },
                  },
              ]
            : []),
        ...(finding.reviewState === null
            ? [
                  {
                      key: "confirm",
                      label: "Confirm it reads correctly",
                      glyph: <CheckGlyph size={15} />,
                      run: () => act("confirm"),
                  },
              ]
            : []),
        ...(!dismissed
            ? [
                  {
                      key: "dismiss",
                      label: "Dismiss: not real text",
                      glyph: <TrashGlyph size={15} />,
                      color: "oxblood",
                      run: () => act("dismiss"),
                  },
              ]
            : []),
        ...(finding.reviewState !== null
            ? [
                  {
                      key: "restore",
                      label: dismissed
                          ? "Undo: show it again"
                          : finding.reviewState === "edited"
                            ? "Undo the correction"
                            : "Undo: mark as unreviewed",
                      glyph: <UndoGlyph size={15} />,
                      run: () => act("restore"),
                  },
              ]
            : []),
    ];

    return (
        <Group
            gap={8}
            wrap="wrap"
            className={classes.findingLine}
            data-dismissed={dismissed || undefined}
        >
            <Text component="span" className={classes.findingText}>
                {finding.text}
            </Text>

            {finding.reviewState === "edited" && (
                <Tooltip label={`Read as “${finding.originalText ?? ""}”`} withArrow>
                    <Badge size="xs" variant="light" color="brass" className={classes.badge}>
                        edited
                    </Badge>
                </Tooltip>
            )}
            {/* One sign per decision: a dismissed line is already struck through, so it carries
                no badge as well. */}
            {finding.reviewState === "confirmed" && (
                <Tooltip label="Confirmed" withArrow>
                    <Text component="span" c="brass.4" display="inline-flex" aria-label="confirmed">
                        <CheckGlyph size={13} />
                    </Text>
                </Tooltip>
            )}

            {detail}

            {isPhone ? (
                <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                        <ActionIcon
                            variant="subtle"
                            color="gray"
                            size={44}
                            aria-label="Review this text"
                            loading={busy}
                        >
                            <MoreGlyph size={18} />
                        </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                        {actions.map((action) => (
                            <Menu.Item
                                key={action.key}
                                leftSection={action.glyph}
                                color={action.color}
                                onClick={action.run}
                            >
                                {action.label}
                            </Menu.Item>
                        ))}
                    </Menu.Dropdown>
                </Menu>
            ) : (
                <Group gap={2} wrap="nowrap" className={classes.findingActions}>
                    {actions.map((action) => (
                        <Tooltip key={action.key} label={action.label} withArrow>
                            <ActionIcon
                                variant="subtle"
                                color={action.color ?? "gray"}
                                size="md"
                                aria-label={action.label}
                                disabled={busy}
                                onClick={action.run}
                            >
                                {action.glyph}
                            </ActionIcon>
                        </Tooltip>
                    ))}
                </Group>
            )}

            {trailing}
        </Group>
    );
};
