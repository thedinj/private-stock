"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    ActionIcon,
    Combobox,
    Group,
    Kbd,
    Menu,
    Stack,
    Text,
    TextInput,
    useCombobox,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";

import type { Tag, TagSearchResponse } from "@private-stock/core";

import {
    CloseGlyph,
    KeywordGlyph,
    LookGlyph,
    PerformerGlyph,
    SearchGlyph,
    SourceGlyph,
    type GlyphProps,
} from "@/components/media/Glyph";
import tagClasses from "@/components/tags/TagNameInput.module.scss";
import { useTagSearch } from "@/lib/api/tags";
import {
    SEARCH_TYPE_INFO,
    SEARCH_TYPES,
    searchHref,
    useSearchType,
    type SearchType,
} from "@/lib/headerSearch";
import { isTypingTarget } from "@/lib/typingTarget";

import classes from "./HeaderSearch.module.scss";

/**
 * The header search (§14 "The header search").
 *
 * One box on every page. The icon at its left is the kind of question -- library, performer,
 * source, keyword, look -- and the kind last asked is remembered on the device. Enter sends the
 * words to that kind's own page; for the tag kinds, the names that match are offered while typing,
 * and picking one goes straight to it.
 *
 * On a phone it is an icon that opens the box over the whole header, because the header has no
 * width to spare for a field that is used now and then.
 */

const TYPE_GLYPH: Record<SearchType, React.FC<GlyphProps>> = {
    library: SearchGlyph,
    performer: PerformerGlyph,
    source: SourceGlyph,
    keyword: KeywordGlyph,
    look: LookGlyph,
};

/** Enough to choose from; more is a reason to press Enter and see the whole list. */
const SUGGESTION_LIMIT = 8;

interface HeaderSearchProps {
    /** The phone layout: an icon that opens the box over the header. */
    compact: boolean;
}

export const HeaderSearch: React.FC<HeaderSearchProps> = ({ compact }) => {
    const router = useRouter();
    const [type, setType] = useSearchType();
    const [text, setText] = useState("");
    const [focused, setFocused] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const combobox = useCombobox({
        onDropdownClose: () => combobox.resetSelectedOption(),
    });

    const info = SEARCH_TYPE_INFO[type];
    const TypeGlyph = TYPE_GLYPH[type];

    /**
     * Names, for the kinds that have them. Nothing is asked until the box is in use and something
     * is typed -- every page carries this box, and no page should pay for it unasked. Keywords
     * search both systems, yours first, as the keywords page lists them.
     */
    const [debounced] = useDebouncedValue(text.trim(), 150);
    const suggest = info.suggest;
    const first = useTagSearch(
        suggest?.kind ?? "",
        suggest?.scopes[0] ?? "public",
        debounced,
        focused && suggest !== null
    );
    const second = useTagSearch(
        suggest?.kind ?? "",
        suggest?.scopes[1] ?? "public",
        debounced,
        focused && suggest !== null && suggest.scopes.length > 1
    );
    /**
     * Whether the list on screen belongs to this search.
     *
     * The tag search keeps its previous answer up while the next is asked for, so the list does
     * not blank between keystrokes. That is right within one search and wrong across two: after
     * finding "anna" among performers, switching to Source and typing showed Anna's names under
     * Source until the new answer came. So a carried-over answer is shown only once this search
     * has had a real one of its own -- for the words actually in the box -- and a finished search
     * or a change of kind starts again from nothing.
     */
    const [live, setLive] = useState(false);
    const typed = text.trim();
    const answered = [first, second].some((query) => query.data && !query.isPlaceholderData);

    useEffect(() => {
        if (typed === "") setLive(false);
        else if (answered && debounced === typed) setLive(true);
    }, [answered, debounced, typed]);

    /**
     * Close spellings only when nothing matched as typed in either system: a near miss among
     * your keywords is not worth showing above an exact shared one.
     */
    const answers = (suggest?.scopes.length === 1 ? [first] : [first, second])
        .filter((query) => !query.isPlaceholderData || live)
        .map((query) => query.data)
        .filter(
            (answer): answer is TagSearchResponse =>
                answer !== undefined &&
                answer.tags.length > 0 &&
                // Belt and braces: never another kind's names, whatever the cache holds.
                answer.tags.every((tag) => tag.kind === suggest?.kind)
        );
    const exact = answers.filter((answer) => !answer.near);
    const near = exact.length === 0 && answers.length > 0;
    const suggestions: Tag[] =
        suggest === null || typed === ""
            ? []
            : (near ? answers : exact).flatMap((answer) => answer.tags).slice(0, SUGGESTION_LIMIT);

    useEffect(() => {
        if (suggestions.length > 0 && focused) combobox.openDropdown();
        else combobox.closeDropdown();
        // `combobox` is a new object every render; what decides is the list and the focus.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [suggestions.length, focused]);

    const focusBox = () => {
        // After the expanding box has rendered, on a phone.
        window.requestAnimationFrame(() => inputRef.current?.focus());
    };

    const finish = () => {
        setText("");
        setLive(false);
        combobox.closeDropdown();
        inputRef.current?.blur();
        setExpanded(false);
    };

    const go = (href: string) => {
        router.push(href);
        finish();
    };

    /**
     * `/` puts you in the box from anywhere (§14 "Hotkeys"), unless you are typing somewhere
     * already or a dialogue has the page -- the box is behind it, and focus would leave the
     * dialogue for something you cannot see.
     */
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
            if (isTypingTarget(event.target)) return;
            if (document.querySelector('[aria-modal="true"]')) return;

            event.preventDefault();
            setExpanded(true);
            focusBox();
        };

        window.addEventListener("keydown", onKey);

        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const typeMenu = (
        <Menu position="bottom-start" withinPortal shadow="md">
            <Menu.Target>
                <ActionIcon
                    variant="subtle"
                    color="brass"
                    className={classes.typeButton}
                    aria-label={`Searching: ${info.label}. Change what to search`}
                    title={`Searching: ${info.label}`}
                >
                    <TypeGlyph size={18} />
                </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
                <Menu.Label>Search for</Menu.Label>
                {SEARCH_TYPES.map((option) => {
                    const OptionGlyph = TYPE_GLYPH[option];

                    return (
                        <Menu.Item
                            key={option}
                            leftSection={<OptionGlyph size={16} />}
                            onClick={() => {
                                setType(option);
                                setLive(false);
                                focusBox();
                            }}
                            data-active={option === type || undefined}
                            className={classes.typeItem}
                            mih={40}
                        >
                            {SEARCH_TYPE_INFO[option].label}
                        </Menu.Item>
                    );
                })}
            </Menu.Dropdown>
        </Menu>
    );

    const box = (
        <Combobox
            store={combobox}
            withinPortal
            position="bottom-start"
            onOptionSubmit={(id) => go(`/tags/${encodeURIComponent(id)}`)}
        >
            <Combobox.Target>
                <TextInput
                    ref={inputRef}
                    classNames={{ root: classes.box, input: classes.input }}
                    value={text}
                    placeholder={info.placeholder}
                    aria-label={info.placeholder}
                    leftSection={typeMenu}
                    leftSectionWidth={44}
                    leftSectionPointerEvents="all"
                    rightSection={
                        compact ? (
                            <ActionIcon
                                variant="subtle"
                                color="gray"
                                aria-label="Close search"
                                onClick={finish}
                            >
                                <CloseGlyph size={16} />
                            </ActionIcon>
                        ) : !focused && text === "" ? (
                            <Kbd className={classes.hint}>/</Kbd>
                        ) : null
                    }
                    rightSectionPointerEvents={compact ? "all" : "none"}
                    enterKeyHint="search"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                        setText(event.currentTarget.value);
                        combobox.resetSelectedOption();
                    }}
                    onFocus={() => setFocused(true)}
                    onBlur={(event) => {
                        setFocused(false);
                        // A phone's box folds away when left empty, so the header comes back --
                        // but not for a tap on its own kind picker or close button.
                        const next = event.relatedTarget;
                        const inside = next instanceof Node && overlayRef.current?.contains(next);

                        if (compact && text.trim() === "" && !inside) setExpanded(false);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Escape" && !combobox.dropdownOpened) {
                            finish();
                            return;
                        }
                        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                        // A suggestion picked with the arrows is the combobox's to open.
                        if (combobox.dropdownOpened && combobox.getSelectedOptionIndex() !== -1) {
                            return;
                        }

                        const href = searchHref(type, text);

                        if (href) {
                            event.preventDefault();
                            go(href);
                        }
                    }}
                />
            </Combobox.Target>

            <Combobox.Dropdown className={classes.dropdown}>
                <Combobox.Options>
                    <Combobox.Group label={near ? "Close spellings" : undefined}>
                        {suggestions.map((tag) => (
                            <Combobox.Option key={tag.id} value={tag.id}>
                                <Group gap="sm" wrap="nowrap" miw={0}>
                                    {tag.picture?.smallUrl && (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={tag.picture.smallUrl}
                                            alt=""
                                            className={tagClasses.picture}
                                            data-portrait={tag.kind === "performer" || undefined}
                                            loading="lazy"
                                            decoding="async"
                                        />
                                    )}
                                    <Stack gap={0} miw={0} style={{ flex: 1 }}>
                                        <Text size="sm" truncate>
                                            {tag.name}
                                        </Text>
                                        {tag.aliases && tag.aliases.length > 0 && (
                                            <Text size="xs" c="dimmed" truncate>
                                                aka {tag.aliases.join(", ")}
                                            </Text>
                                        )}
                                    </Stack>
                                    {tag.private && (
                                        <Text size="xs" c="dimmed" style={{ flex: "none" }}>
                                            yours
                                        </Text>
                                    )}
                                    <Text size="xs" c="dimmed" style={{ flex: "none" }}>
                                        {(tag.mediaCount ?? 0).toLocaleString()}
                                    </Text>
                                </Group>
                            </Combobox.Option>
                        ))}
                    </Combobox.Group>
                </Combobox.Options>
                <Combobox.Footer>
                    <Text size="xs" c="dimmed">
                        <Kbd size="xs">Enter</Kbd> lists every match
                    </Text>
                </Combobox.Footer>
            </Combobox.Dropdown>
        </Combobox>
    );

    if (!compact) return <div className={classes.wide}>{box}</div>;

    return (
        <>
            <ActionIcon
                variant="subtle"
                color="gray"
                size={44}
                aria-label="Search"
                onClick={() => {
                    setExpanded(true);
                    focusBox();
                }}
            >
                <SearchGlyph size={20} />
            </ActionIcon>
            {expanded && (
                <div ref={overlayRef} className={classes.overlay}>
                    {box}
                </div>
            )}
        </>
    );
};
