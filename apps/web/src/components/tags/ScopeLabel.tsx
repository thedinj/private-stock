"use client";

import { Text, Tooltip } from "@mantine/core";

import type { TagScope } from "@private-stock/core";

/**
 * Whose a box of tags is: "Shared" or "Private" (§6, §14b).
 *
 * The item page's tag boxes and the filter panel's chip groups both start with this line, and
 * they have to say the same word or one system looks like two. One word, and nothing beside
 * it: a badge reading "everyone" after "Shared" said the same thing twice in two vocabularies.
 * What the word means in practice is the tooltip, for whoever wants it spelled out.
 *
 * Whose, not what: the section heading above has already said what.
 *
 * Keywords only. Callers check `allowsPrivate(kind)` first: a performer or a source is always
 * the library's, and is never called shared anywhere (§6).
 */
export const ScopeLabel: React.FC<{ scope: TagScope }> = ({ scope }) => (
    <Tooltip
        label={
            scope === "public"
                ? "Everyone sees these, and anyone can add or remove one."
                : "Only you can see these, and only you can search them."
        }
        withinPortal
    >
        <Text size="sm" fw={500}>
            {scope === "public" ? "Shared" : "Private"}
        </Text>
    </Tooltip>
);
