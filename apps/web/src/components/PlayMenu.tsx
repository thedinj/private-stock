"use client";

import { useRouter } from "next/navigation";
import { Button, Menu, Text } from "@mantine/core";

import { domainProfiles } from "@private-stock/core";

import { CheckGlyph, PlayGlyph, ShowcaseGlyph, TastingGlyph } from "@/components/media/Glyph";
import { getActiveDomain } from "@/lib/activeDomain";
import { openFullScreenMode } from "@/lib/fullScreenEntry";
import { SHOWCASE_PATH, TASTING_PATH } from "@/lib/showcase/set";
import { forgetTastingPosition } from "@/lib/tasting/restore";

interface PlayMenuProps {
    /** The set, as the showcase and the tasting read it from their address. */
    setParams: URLSearchParams;
    /**
     * Open the set's first item in the viewer, with the set behind it -- in review mode when
     * `review` (§14d), which only a room that reviews offers.
     */
    onFromTop: (review: boolean) => void;
    /** The set is known to be empty, so there is nothing to start. */
    empty: boolean;
    /** A thumb's worth on a phone (CLAUDE.md); the default otherwise. */
    height?: string;
}

/**
 * Play: putting a set on the screen, four ways (§14f, §14g, §14d).
 *
 * Playing from the top, Showcase and Tasting are one decision -- "put this set on the screen"
 * -- and all leave the page, so they are one button with a choice behind it rather than three
 * among the page's own controls. Shared by every page that has a set to play -- the library, a
 * playlist and a tag's own page -- so the choice reads the same wherever it is offered.
 *
 * The page's primary action, so the one filled brass button on it (§14, "house rules").
 */
export const PlayMenu: React.FC<PlayMenuProps> = ({ setParams, onFromTop, empty, height }) => {
    const router = useRouter();

    return (
        <Menu position="bottom-end" withinPortal>
            <Menu.Target>
                <Button color="brass" h={height} leftSection={<PlayGlyph size={16} />}>
                    Play
                </Button>
            </Menu.Target>
            <Menu.Dropdown>
                {/* First: the plainest reading of "Play". */}
                <Menu.Item
                    onClick={() => onFromTop(false)}
                    disabled={empty}
                    leftSection={<PlayGlyph />}
                >
                    <Text size="sm">From the top</Text>
                    <Text size="xs" c="dimmed">
                        The first item, then on through the set
                    </Text>
                </Menu.Item>
                {/* Review (§14d): the same set, gone through one decision at a time. Which items
                    are in it is the set's business -- a backlog is a view of what is not
                    reviewed. */}
                <Menu.Item
                    onClick={() => onFromTop(true)}
                    disabled={empty}
                    leftSection={<CheckGlyph />}
                >
                    <Text size="sm">Review</Text>
                    <Text size="xs" c="dimmed">
                        {domainProfiles[getActiveDomain()].tailMs !== null
                            ? "Each from its last seconds, waiting for d"
                            : "One at a time, waiting for d"}
                    </Text>
                </Menu.Item>
                <Menu.Item
                    onClick={() =>
                        openFullScreenMode(SHOWCASE_PATH, setParams, (href) => router.push(href))
                    }
                    disabled={empty}
                    leftSection={<ShowcaseGlyph />}
                >
                    <Text size="sm">Showcase</Text>
                    <Text size="xs" c="dimmed">
                        A drifting wall of the whole set
                    </Text>
                </Menu.Item>
                {/* Entering from here starts at the beginning; only the viewer's way back
                    resumes (§14g). */}
                <Menu.Item
                    onClick={() => {
                        forgetTastingPosition();
                        openFullScreenMode(TASTING_PATH, setParams, (href) => router.push(href));
                    }}
                    disabled={empty}
                    leftSection={<TastingGlyph />}
                >
                    <Text size="sm">Tasting</Text>
                    <Text size="xs" c="dimmed">
                        A few seconds of each, one at a time
                    </Text>
                </Menu.Item>
            </Menu.Dropdown>
        </Menu>
    );
};
