import { allowsPrivate, type TagScope } from "@private-stock/core";

/**
 * Where typed names go: a facet, and for keywords an audience, chosen in one tap (§6).
 *
 * They were two controls — a Shared/Private switch and a facet dropdown — and on a phone the
 * dropdown cost two taps and a list over the whole screen before anything could be typed. Only
 * `tag` can be private, so the combinations fit in one row; the switch had only ever been hiding
 * the dropdown when it went private.
 *
 * Built from a facet list rather than fixed, because an item takes three facets and a clip two
 * (§14d "Tagging clips").
 */
export interface TagDestination {
    kind: string;
    scope: TagScope;
}

export const destinationsFor = (kinds: readonly string[]): TagDestination[] =>
    kinds.flatMap((kind) =>
        allowsPrivate(kind)
            ? [
                  { kind, scope: "public" as const },
                  { kind, scope: "private" as const },
              ]
            : [{ kind, scope: "public" as const }]
    );

export const destinationKey = ({ kind, scope }: TagDestination): string => `${scope}:${kind}`;
