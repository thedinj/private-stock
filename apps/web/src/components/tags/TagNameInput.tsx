"use client";

import { useMemo, useState } from "react";
import {
    Group,
    Stack,
    TagsInput,
    Text,
    type ComboboxItem,
    type OptionsFilter,
    type TagsInputProps,
} from "@mantine/core";

import { useDebouncedValue } from "@mantine/hooks";

import { normalizeName, type TagScope } from "@private-stock/core";

import { useTagSearch } from "@/lib/api/tags";

import classes from "./TagNameInput.module.scss";

/**
 * The one box anybody types a tag name into (§5b).
 *
 * There were four, and only one of them suggested anything — the detail drawer's. The two
 * that can write thousands of assignments in a single gesture, the selection bar's and the
 * filter-wide apply, offered no help spelling a name at all, which is how a library ends up
 * with "beach", "Beach " and "beaches" all meaning the same thing. Suggesting is the cheapest
 * defence against that, and it belongs in one place so it cannot be true of some boxes only.
 *
 * **Counts are shown beside each name**, because a suggestion list without them cannot tell
 * the library's `beach` on four hundred items from somebody's stray `Beach ` on one, and the
 * stray is exactly what somebody is about to apply to four hundred more.
 *
 * **What matches is the server's, over the whole vocabulary** (§5b "One rule for names"). The
 * box used to filter the 500 most-used names in the browser by a rule of its own, so a rare name
 * was never offered and "zoe" did not find Zoë. Now what is typed is sent, and the facet's names
 * come back matched by the server's rule and ordered by how well each matches (`orderTagMatches`)
 * -- `beachfront` while you type `beach`, the whole name first.
 *
 * **Typing a new name still works, including one that is a prefix of an existing tag**, and
 * pressing Enter still commits what was typed rather than what was offered.
 * That is the property this control must not lose — a vocabulary nobody can add to stops
 * describing the library within a week.
 *
 * **Aliases find their tag** (§5b "Aliases"). Typing a performer's maiden name offers the tag
 * filed under the married one, with the alias shown beneath it, and picking it commits the
 * tag's own name. Pressing Enter on the alias itself works too -- the server resolves it -- so
 * the suggestion is a courtesy rather than the only way through.
 *
 * **A tag with a picture shows it** (§6 "A tag's picture"), at the size of an item's tag cards
 * and never smaller: the way to tell two Annas apart is to see them. The list is a few names
 * long by the time anybody reads it, so the height costs little.
 */

interface TagNameInputProps extends Omit<TagsInputProps, "data" | "renderOption"> {
    /** The facet being named. Suggestions are that facet's, and nothing else's. */
    kind: string;
    /** Which of the two systems the name resolves in (§6). */
    scope: TagScope;
    /**
     * Names to leave out of the suggestions, for a box whose chips are drawn outside it.
     *
     * `TagsInput` hides what is in its own `value`; the item page keeps its chips elsewhere and
     * the box empty, so without this it offered the tags the item already has.
     */
    exclude?: string[];
}

/**
 * On a phone, lift the box to the top of the screen once the keyboard is up.
 *
 * The keyboard takes the bottom half of the screen, and the suggestions open *below* the box:
 * a box anywhere but near the top had its list drawn behind the keyboard, and one low on the
 * page was covered itself. Scrolling it under the header leaves the list the room between the
 * box and the keyboard.
 *
 * Waits for the keyboard, because scrolling before it opens measures a screen that is about to
 * lose half its height -- on the visual viewport's resize where there is one, else a moment
 * later. Touch only: with a mouse there is no keyboard to make room for, and moving the page
 * under somebody's pointer when they click a box would be its own annoyance.
 */
const liftAboveKeyboard = (box: HTMLElement | null): void => {
    if (!box || !window.matchMedia("(pointer: coarse)").matches) return;

    const viewport = window.visualViewport;
    let done = false;

    const lift = () => {
        if (done) return;
        done = true;
        viewport?.removeEventListener("resize", lift);
        box.scrollIntoView({ block: "start", behavior: "smooth" });
    };

    viewport?.addEventListener("resize", lift);
    window.setTimeout(lift, 400);
};

export const TagNameInput: React.FC<TagNameInputProps> = ({
    kind,
    scope,
    exclude,
    onFocus,
    searchValue,
    onSearchChange,
    className,
    ...rest
}) => {
    /**
     * What is typed, followed here whether or not the caller controls it, for the "Add" row.
     */
    const [ownSearch, setOwnSearch] = useState("");
    const typed = (searchValue ?? ownSearch).trim();

    /**
     * Nothing is fetched until the box is touched and something is typed.
     *
     * The viewer's boxes stay quiet until somebody means to type in one, which is what keeps a
     * page about playing a video from asking for autocomplete nobody wanted. Debounced, so a name
     * typed at speed is one request, and the previous answer stays up while the next comes.
     */
    const [focused, setFocused] = useState(false);
    const [debounced] = useDebouncedValue(typed, 150);
    const { data } = useTagSearch(kind, scope, debounced, focused);

    const { names, counts, aliases, pictures, near } = useMemo(() => {
        const tags = data?.tags ?? [];

        return {
            names: tags.map((tag) => tag.name),
            // `renderOption` for a TagsInput is handed `{ value }` and nothing else, so the
            // count cannot ride along on the option and has to be looked up by name.
            counts: new Map(tags.map((tag) => [tag.name, tag.mediaCount ?? 0])),
            aliases: new Map(tags.map((tag) => [tag.name, tag.aliases ?? []])),
            pictures: new Map(tags.map((tag) => [tag.name, tag.picture?.smallUrl ?? null])),
            near: data?.near ?? false,
        };
    }, [data]);

    const excluded = useMemo(() => new Set((exclude ?? []).map(normalizeName)), [exclude]);

    /**
     * A row saying a new name will be coined, when nothing already answers to it.
     *
     * Typing a name nobody has used showed no list at all, which read as "nothing will happen"
     * -- the box gave no sign that Enter creates a tag. It is a real entry in `data`, because
     * `TagsInput` looks a picked option up there. "Answers to it" is the one rule's: typing "zoe"
     * when Zoë exists, or an alias in full, is not a new name.
     */
    const typedName = normalizeName(typed);
    const offering =
        typedName !== "" &&
        !excluded.has(typedName) &&
        !names.some((name) =>
            [name, ...(aliases.get(name) ?? [])].some(
                (candidate) => normalizeName(candidate) === typedName
            )
        )
            ? typed
            : null;

    /**
     * The server's matches, in its order. Close spellings (`near`) come after the new name on
     * offer: "did you mean" without taking the choice away -- in a vocabulary where "Aunt Margret"
     * would be a second tag for the same person, the near spelling is the one to see before
     * pressing Enter, but it may also really be somebody else.
     */
    const filter: OptionsFilter = ({ options, search, limit }) => {
        /**
         * Nothing until something is typed, in every box. A list shown on focus alone appears
         * before anybody has asked for it and covers whatever sits below. Whitespace is not
         * something typed. No options hides the dropdown.
         */
        if (search.trim() === "") return [];

        const items = new Map(
            options
                .filter((option): option is ComboboxItem => "value" in option)
                .map((option) => [option.value, option])
        );
        const offer = offering ? items.get(offering) : undefined;
        const shown = names
            .filter((name) => !excluded.has(normalizeName(name)))
            .flatMap((name) => items.get(name) ?? []);

        if (!near && shown.length > 0) return shown.slice(0, limit);

        return offer ? [offer, ...shown.slice(0, limit - 1)] : shown.slice(0, limit);
    };

    return (
        <TagsInput
            className={className ? `${classes.box} ${className}` : classes.box}
            data={offering ? [...names, offering] : names}
            searchValue={searchValue}
            onSearchChange={(value) => {
                setOwnSearch(value);
                onSearchChange?.(value);
            }}
            // A facet on a real library runs to hundreds and the dropdown would render every
            // match. Fifty is more than anybody reads before narrowing what they typed.
            limit={50}
            // Vertical only. The inner box's width is the module's: see `.suggestions`.
            scrollAreaProps={{ scrollbars: "y", className: classes.suggestions }}
            onFocus={(event) => {
                setFocused(true);
                liftAboveKeyboard(event.currentTarget.closest<HTMLElement>(`.${classes.box}`));
                // Taken apart from `rest` and called on: spreading a caller's `onFocus` over
                // this one would leave the box with no suggestions and nothing to say so.
                onFocus?.(event);
            }}
            filter={filter}
            renderOption={({ option }) => {
                if (option.value === offering) {
                    return (
                        <Group justify="space-between" gap="sm" w="100%" miw={0} wrap="nowrap">
                            {/* `miw={0}` so a long name truncates rather than widening the
                                dropdown into a sideways scroll. */}
                            <Text size="sm" truncate miw={0}>
                                Add “{option.value}”
                            </Text>
                            <Text size="xs" c="dimmed" style={{ flex: "none" }}>
                                new
                            </Text>
                        </Group>
                    );
                }

                const aka = aliases.get(option.value) ?? [];
                const picture = pictures.get(option.value);

                return (
                    <Group justify="space-between" gap="sm" w="100%" miw={0} wrap="nowrap">
                        {picture && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={picture}
                                alt=""
                                className={classes.picture}
                                data-portrait={kind === "performer" || undefined}
                                loading="lazy"
                                decoding="async"
                            />
                        )}
                        <Stack gap={0} miw={0} style={{ flex: 1 }}>
                            <Text size="sm" truncate>
                                {option.value}
                            </Text>
                            {aka.length > 0 && (
                                <Text size="xs" c="dimmed">
                                    aka {aka.join(", ")}
                                </Text>
                            )}
                        </Stack>
                        <Text size="xs" c="dimmed" style={{ flex: "none" }}>
                            {(counts.get(option.value) ?? 0).toLocaleString()}
                        </Text>
                    </Group>
                );
            }}
            {...rest}
        />
    );
};
