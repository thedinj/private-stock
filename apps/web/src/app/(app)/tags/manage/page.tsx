"use client";

import { useState } from "react";
import { Alert, Button, Card, Group, Stack, Text, Title } from "@mantine/core";

import { allowsPrivate, isKnownFacet, tagKinds } from "@private-stock/core";

import { useAuth } from "@/lib/api/AuthProvider";
import { useFacetKinds, useTagBatches, useUndoBatch } from "@/lib/api/tags";
import { facetLabelPlural } from "@/lib/facetLabels";
import { ScopeLabel } from "@/components/tags/ScopeLabel";
import { VocabularyTable } from "@/components/tags/VocabularyTable";
import { PagePlate } from "@/components/shell/PagePlate";

/**
 * Managing the tag vocabulary (§6).
 *
 * The Tags section's fourth page. Performers, Sources and Keywords are for looking; this is
 * for tidying -- every facet in one searchable table, the unused tags a cleanup is after, and
 * the bulk applies that can still be withdrawn. One-off fixes are also on each browse row's
 * menu, which opens these same dialogues.
 *
 * A page for everybody rather than an admin card, because everybody has private tags. The
 * *actions* gate instead of the page: `AppNavbar` hides Duplicates, Trash and Admin behind the
 * `admin` scope as a block, and a screen where a regular account can do half the things on it
 * does not belong in that block.
 *
 * **A card per facet, laid out as the item editor lays them out (§14b).** Performers, Sources
 * and Keywords, in `tagKinds` order, then any facet a scraper invented. Keywords holds two tables,
 * Shared then Private, because it is the only facet that can be private (§6); Performers and
 * Sources hold one and are never called shared. It was two cards, one per system, and the first
 * put every performer under a heading reading "Shared".
 *
 * The known facets are drawn empty too, as the editor draws them, so the page does not
 * rearrange itself the first time somebody tags a source.
 *
 * **"Anyone coins, an administrator curates"** is stated on the page, because the two halves
 * look like one permission and are not. Coining a public tag is open to everybody — type it in
 * the box, apply it in bulk — while renaming, merging and deleting one that exists is not. An
 * open vocabulary needs both: without the first nobody contributes, without the second nobody
 * can clean up after them.
 */

const ManageTagsPage: React.FC = () => {
    const { hasScope } = useAuth();
    const [done, setDone] = useState<string | null>(null);

    const batches = useTagBatches();
    const undo = useUndoBatch((result) =>
        setDone(`Withdrawn — ${result.removed} tag${result.removed === 1 ? "" : "s"} removed`)
    );

    const pending = (batches.data?.batches ?? []).filter((batch) => !batch.undoneAt);

    const kinds = useFacetKinds();
    const sections = [
        ...tagKinds,
        ...(kinds.data?.kinds ?? []).filter((kind) => !isKnownFacet(kind)),
    ];

    const curator = hasScope("admin");
    const readOnlyNote = !curator && (
        <Text size="xs" c="dimmed">
            read-only — an administrator curates these
        </Text>
    );

    return (
        <Stack gap="lg">
            <PagePlate
                eyebrow="Tags"
                title="Manage"
                lede="Anyone can add a tag to the library. Renaming, merging and deleting one stay with an administrator, so a shared name cannot change under everybody at once."
            />

            {/* The cards keep a readable measure; the plate runs the page's width, as every
                plate does, so its rule is not cut off short of the page (§14, "house rules"). */}
            <Stack gap="lg" maw={980}>
                {/* One line, cleared by the next action rather than dismissed: every change here
                is retroactive and silent, so "412 items" is the only evidence it happened. */}
                {done && (
                    <Alert
                        variant="light"
                        color="brass"
                        onClose={() => setDone(null)}
                        withCloseButton
                    >
                        {done}
                    </Alert>
                )}

                {sections.map((kind) => (
                    <Card key={kind} p="md">
                        <Stack gap="md">
                            <Group gap={6} align="baseline">
                                <Title order={4}>{facetLabelPlural(kind)}</Title>
                                {/* On the card for a facet that is only ever the library's; on
                                    Keywords it belongs to the Shared half alone, since your
                                    private ones are always yours to tidy. */}
                                {!allowsPrivate(kind) && readOnlyNote}
                            </Group>

                            {allowsPrivate(kind) ? (
                                (["public", "private"] as const).map((scope) => (
                                    <Stack key={scope} gap="xs">
                                        <Group gap={6} align="baseline">
                                            <ScopeLabel scope={scope} />
                                            {scope === "public" && readOnlyNote}
                                        </Group>
                                        <VocabularyTable
                                            kind={kind}
                                            scope={scope}
                                            // Always the curator of your own, administrator or
                                            // not: a private tag has exactly one person who
                                            // could be asked about it (§6).
                                            curator={scope === "private" || curator}
                                            onDone={setDone}
                                        />
                                    </Stack>
                                ))
                            ) : (
                                <VocabularyTable
                                    kind={kind}
                                    scope="public"
                                    curator={curator}
                                    onDone={setDone}
                                />
                            )}
                        </Stack>
                    </Card>
                ))}

                <Card p="md">
                    <Stack gap="md">
                        <Stack gap={2}>
                            <Title order={4}>Bulk tagging</Title>
                            <Text size="sm" c="dimmed">
                                Applies made from a filter, newest first. Withdrawing one removes
                                exactly the assignments it wrote — a tag somebody typed by hand on
                                the same item survives.
                            </Text>
                        </Stack>

                        {pending.length === 0 ? (
                            <Text size="sm" c="dimmed">
                                Nothing to withdraw. Filter the library and use “Tag everything
                                matching” to apply a tag to a whole set at once.
                            </Text>
                        ) : (
                            <Stack gap="xs">
                                {pending.map((batch) => (
                                    <Group key={batch.id} justify="space-between" wrap="nowrap">
                                        <Stack gap={0} style={{ minWidth: 0 }}>
                                            <Text size="sm" lineClamp={1}>
                                                {batch.summary}
                                            </Text>
                                            <Text size="xs" c="dimmed">
                                                {new Date(batch.createdAt).toLocaleString()}
                                            </Text>
                                        </Stack>
                                        <Button
                                            size="xs"
                                            variant="subtle"
                                            color="oxblood"
                                            loading={undo.isPending && undo.variables === batch.id}
                                            onClick={() => undo.mutate(batch.id)}
                                        >
                                            Withdraw
                                        </Button>
                                    </Group>
                                ))}
                            </Stack>
                        )}
                    </Stack>
                </Card>
            </Stack>
        </Stack>
    );
};

export default ManageTagsPage;
