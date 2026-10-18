"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Center, Collapse, Group, Pagination, Paper, Stack, Text } from "@mantine/core";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { DupeApartDecision, DupeApartListResponse } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { rememberReturn } from "@/lib/returnTo";

import classes from "./SortedApart.module.scss";

/**
 * Sortings that kept look-alikes apart, to take back (§10i).
 *
 * On the Reviewed tab because that is where a decision is gone back to, and folded by default:
 * it is the list somebody opens after a mistake, not one they read on every visit. Taking one
 * back says nothing about the copies; the next clustering pass compares them again and groups
 * them as it would have before anybody sorted them.
 */

const PAGE_SIZE = 20;

const Decision: React.FC<{ decision: DupeApartDecision }> = ({ decision }) => {
    const queryClient = useQueryClient();
    const undo = useMutation({
        mutationFn: () =>
            api(`/api/dupes/apart/${encodeURIComponent(decision.id)}`, { method: "DELETE" }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.dupes.all() }),
    });

    return (
        <div className={classes.decision}>
            <div className={classes.sets}>
                {decision.sets.map((set) => (
                    <div key={set.map((copy) => copy.id).join()} className={classes.set}>
                        {set.map((copy) => (
                            <Link
                                key={copy.id}
                                href={`/media/${copy.id}`}
                                onClick={rememberReturn}
                                className={classes.copy}
                                data-active={copy.active}
                                title={copy.active ? copy.title : `${copy.title} (in the trash)`}
                            >
                                {copy.coverUrl ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={copy.coverUrl} alt="" loading="lazy" />
                                ) : (
                                    <span>{copy.title}</span>
                                )}
                            </Link>
                        ))}
                    </div>
                ))}
            </div>

            <Group gap="xs" justify="space-between">
                <Text size="xs" c="dimmed">
                    {new Date(decision.decidedAt.replace(" ", "T") + "Z").toLocaleDateString()}
                    {decision.decidedBy ? ` · ${decision.decidedBy}` : ""}
                </Text>
                {undo.isSuccess ? (
                    <Text size="xs" c="dimmed">
                        Taken back. They are compared again shortly.
                    </Text>
                ) : (
                    <Button
                        size="compact-xs"
                        variant="subtle"
                        color="brass"
                        loading={undo.isPending}
                        onClick={() => undo.mutate()}
                    >
                        Take back
                    </Button>
                )}
            </Group>
        </div>
    );
};

export const SortedApart: React.FC = () => {
    const [open, setOpen] = useState(false);
    const [page, setPage] = useState(1);
    const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
    }).toString();

    // The count is the first page's, so the folded line can say how many there are.
    const { data } = useQuery({
        queryKey: queryKeys.dupes.apart(params),
        queryFn: () => api<DupeApartListResponse>(`/api/dupes/apart?${params}`),
        placeholderData: keepPreviousData,
    });

    if (!data || data.total === 0) {
        return null;
    }

    const pageCount = Math.ceil(data.total / PAGE_SIZE);

    return (
        <Paper withBorder radius="md" p="sm" mb="lg">
            <Stack gap="sm">
                <Group justify="space-between">
                    <Text size="sm">
                        Sorted apart · {data.total.toLocaleString()}{" "}
                        <Text span size="xs" c="dimmed">
                            look-alikes you said are not all the same thing
                        </Text>
                    </Text>
                    <Button
                        size="compact-sm"
                        variant="subtle"
                        color="brass"
                        onClick={() => setOpen((value) => !value)}
                    >
                        {open ? "Hide" : "Show"}
                    </Button>
                </Group>

                <Collapse in={open}>
                    <Stack gap="xs">
                        <Text size="xs" c="dimmed">
                            Each line is one sorting, its sets side by side. Taking one back lets
                            the copies be grouped together again.
                        </Text>
                        {data.decisions.map((decision) => (
                            <Decision key={decision.id} decision={decision} />
                        ))}
                        {pageCount > 1 && (
                            <Center>
                                <Pagination
                                    size="sm"
                                    value={page}
                                    onChange={setPage}
                                    total={pageCount}
                                    color="brass"
                                />
                            </Center>
                        )}
                    </Stack>
                </Collapse>
            </Stack>
        </Paper>
    );
};
