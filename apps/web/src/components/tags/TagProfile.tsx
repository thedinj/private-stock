"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Anchor, Box, Button, Center, Group, Loader, Stack, Text } from "@mantine/core";

import { tagProfileKind, type MediaListItem } from "@private-stock/core";

import { FavoriteToggle } from "@/components/FavoriteToggle";
import { LoadFailed } from "@/components/LoadFailed";
import { SectionHead, TileGrid } from "@/components/library/LibraryRoom";
import { useAuth } from "@/lib/api/AuthProvider";
import { useTagFavorite, useTagProfile } from "@/lib/api/tags";
import { facetLabel, facetLabelPlural } from "@/lib/facetLabels";
import { openFullScreenMode } from "@/lib/fullScreenEntry";
import { SHOWCASE_PATH, TASTING_PATH } from "@/lib/showcase/set";
import { useRememberedHref } from "@/lib/rememberedPages";
import { forgetTastingPosition } from "@/lib/tasting/restore";
import { isTypingTarget } from "@/lib/typingTarget";
import { useTagSeed } from "@/lib/useTagSeed";

import { CompanionsSection } from "./CompanionsSection";
import { KindCounts } from "./KindCounts";
import { TagPictureInset } from "./TagPictureInset";
import { TagPicturePicker } from "./TagPicturePicker";
import { TagRowActions } from "./TagRowActions";
import classes from "./TagProfile.module.scss";

/**
 * One tag's own page: a person, a source, a keyword (§6 "Tags").
 *
 * What the browse row's name leads to, and the answer to "show me Dad". A picture window like
 * the room's, the counts as ways straight into the grid, the set put on screen as a tasting or
 * a showcase, and three short shelves. The whole set is always one click away -- this page is
 * a way in, not a second grid.
 *
 * For a performer, the people they appear with, because that is the next question -- below the
 * shelves, and fetched on its own once it nears the viewport (`CompanionsSection`).
 *
 * The heart leads the actions, and answers to `h` as an item's does (§6 "Favourite tags"):
 * one key for "I like this" wherever there is one thing on screen to like.
 */

export const TagProfile: React.FC<{ tagId: string }> = ({ tagId }) => {
    const router = useRouter();
    const { hasScope } = useAuth();
    const { seed } = useTagSeed();
    const { data, error, isLoading, refetch } = useTagProfile(tagId, seed);
    const heart = useTagFavorite(tagId, data?.favorite ?? false);
    const [choosingPicture, setChoosingPicture] = useState(false);
    const { toggle } = heart;
    const loaded = data !== undefined;

    /**
     * h for heart, as on an item's page. An effect because a key binding is a subscription to
     * the window, not a fetch; it steps aside for typing -- a rename dialogue opened from the
     * menu is a text box -- and for a held key, which would otherwise flicker the mark.
     */
    useEffect(() => {
        if (!loaded) {
            return;
        }

        const listener = (event: KeyboardEvent) => {
            if (
                event.key !== "h" ||
                event.repeat ||
                event.ctrlKey ||
                event.metaKey ||
                event.altKey ||
                isTypingTarget(event.target)
            ) {
                return;
            }

            event.preventDefault();
            toggle();
        };

        window.addEventListener("keydown", listener);

        return () => window.removeEventListener("keydown", listener);
    }, [loaded, toggle]);

    /**
     * Back to the list as it was left, not its plain address (§14b): the search, sort and
     * pictures you opened this tag from. All four up front, because hooks cannot wait for the
     * tag's kind to load.
     */
    const browseHref: Record<string, string> = {
        performer: useRememberedHref("/tags/performers"),
        source: useRememberedHref("/tags/sources"),
        tag: useRememberedHref("/tags/keywords"),
    };
    const manageHref = useRememberedHref("/tags/manage");

    if (error) {
        return <LoadFailed error={error} what="this tag" onRetry={() => void refetch()} />;
    }

    if (isLoading || !data) {
        return (
            <Center h={320}>
                <Loader size="sm" color="brass" />
            </Center>
        );
    }

    const { tag, hero, shelves } = data;
    const scope = tag.private ? "private" : "public";
    const total = data.videoCount + data.imageCount;
    /**
     * The set this page puts on screen: the tag's videos, or its photos when it has none, as the
     * server chose for the shelves (§14e "Videos unless you ask"). The tasting, the showcase and
     * every "see all" take it, so none of them opens on the photos of a tag that has videos --
     * those are on the counts beside the name.
     */
    const kind = tagProfileKind(data);
    const shown = kind === "video" ? data.videoCount : data.imageCount;
    const setParams = new URLSearchParams({ view: "grid", tags: tag.id });
    if (kind === "image") setParams.set("kind", "image");
    const allHref = `/?${setParams.toString()}`;
    const back = browseHref[tag.kind] ?? manageHref;
    /**
     * Their confirmed faces are offered as pictures to an administrator, for a library performer:
     * faces are confirmed for the library, and only administrators confirm them (§5f).
     */
    const facesToChoose = tag.kind === "performer" && !tag.private && hasScope("admin");
    /** With no picture of its own, the window's item stands in, as it did on the browse tile. */
    const standIn = !tag.picture && hero?.coverUrl ? { ...hero, coverUrl: hero.coverUrl } : null;

    const shelf = (title: string, items: MediaListItem[], href: string) =>
        items.length > 0 && (
            <Box>
                <SectionHead title={title} href={href} />
                <TileGrid items={items} />
            </Box>
        );

    return (
        <Box>
            <Box
                className={`${classes.bleed} ${classes.hero}`}
                data-pictured={tag.picture || standIn ? true : undefined}
            >
                {hero?.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={hero.coverUrl} alt="" className={classes.heroImage} />
                ) : (
                    <Box className={classes.heroFallback} />
                )}
                <Box className={classes.scrimSide} />
                <Box className={classes.scrimFoot} />

                <Box className={classes.heroCopy}>
                    {/* Their own picture, beside the name: the window is the day's sample of
                        their items, this is who they are (§6 "A tag's picture"). Without one, a
                        stand-in, which the inset's menu can keep. */}
                    {tag.picture ? (
                        <TagPictureInset
                            tag={tag}
                            picture={tag.picture}
                            onChoose={() => setChoosingPicture(true)}
                        />
                    ) : (
                        standIn && (
                            <TagPictureInset
                                tag={tag}
                                standIn={standIn}
                                onChoose={() => setChoosingPicture(true)}
                            />
                        )
                    )}
                    <Box className={classes.heroText}>
                        <Anchor
                            component={Link}
                            href={back}
                            size="xs"
                            c="oak.3"
                            underline="never"
                            className={classes.back}
                        >
                            ← {facetLabelPlural(tag.kind)}
                        </Anchor>
                        <Text className={classes.eyebrow}>
                            {tag.private
                                ? `Your ${facetLabel(tag.kind).toLowerCase()}`
                                : facetLabel(tag.kind)}
                        </Text>
                        <h1 className={classes.title}>{tag.name}</h1>
                        {(tag.aliases?.length ?? 0) > 0 && (
                            <Text size="sm" c="oak.3">
                                also {tag.aliases?.join(", ")}
                            </Text>
                        )}
                        <KindCounts
                            tagId={tag.id}
                            videoCount={data.videoCount}
                            imageCount={data.imageCount}
                            size="lg"
                        />

                        <Group gap="sm" wrap="wrap" mt={4}>
                            <FavoriteToggle
                                favorite={heart.favorite}
                                onToggle={toggle}
                                burstKey={heart.burstKey}
                                shortcut
                                // The height of the buttons beside it, and a thumb's worth.
                                size="xl"
                            />
                            {/* The primary action, so the one filled brass button (§14). A tasting
                            is the "show me" of a set, and it comes back here when it ends. */}
                            <Button
                                color="brass"
                                size="md"
                                disabled={total === 0}
                                onClick={() => {
                                    forgetTastingPosition();
                                    openFullScreenMode(TASTING_PATH, setParams, (href) =>
                                        router.push(href)
                                    );
                                }}
                            >
                                Tasting
                            </Button>
                            <Button
                                variant="default"
                                size="md"
                                disabled={total === 0}
                                onClick={() =>
                                    openFullScreenMode(SHOWCASE_PATH, setParams, (href) =>
                                        router.push(href)
                                    )
                                }
                            >
                                Showcase
                            </Button>
                            <Button
                                component={Link}
                                href={allHref}
                                variant="subtle"
                                color="brass"
                                size="md"
                            >
                                See all {shown.toLocaleString()}
                            </Button>
                            {/* Finding more of this tag is its own page: what it asks
                            reads faces across the library, and browsing must never wait on it
                            (§6 "Tags", §5f "Starting from the performer"). */}
                            <Button
                                component={Link}
                                href={`/tags/${tag.id}/organise`}
                                prefetch={false}
                                variant="subtle"
                                color="brass"
                                size="md"
                            >
                                Organise
                            </Button>
                            <TagRowActions
                                tag={{ ...tag, mediaCount: total }}
                                scope={scope}
                                curator={tag.private || hasScope("admin")}
                                // An edit refreshes this page through the vocabulary cascade; a
                                // delete or merge leaves no tag here, so it goes back to the list.
                                onDone={() => undefined}
                                onGone={() => router.push(back)}
                                onChoosePicture={() => setChoosingPicture(true)}
                                variant="menu"
                            />
                        </Group>
                    </Box>
                </Box>
            </Box>

            {/* The one place a picture is chosen (§6 "A tag's picture"): their faces, the page's
                own shelves -- nothing new to ask for, and the shuffled one changes with the
                seed -- or the stand-in, kept. */}
            <TagPicturePicker
                opened={choosingPicture}
                onClose={() => setChoosingPicture(false)}
                tag={tag}
                faces={facesToChoose}
                standIn={standIn}
                items={[...shelves.shuffled, ...shelves.recent, ...shelves.topRated].filter(
                    (item, index, all) => all.findIndex((other) => other.id === item.id) === index
                )}
            />

            <Stack gap={40} mt={40}>
                {shelf("Recently added", shelves.recent, allHref)}
                {shelf("Top rated", shelves.topRated, `${allHref}&sort=rating`)}
                {shelf("Shuffled", shelves.shuffled, `${allHref}&sort=random&seed=${seed}`)}

                {/* Last, and asked for only once it is nearly in view: the tag's own items
                    are what the page is for, and the page no longer waits on this (§20).
                    Library performers only -- nothing else has companions. */}
                {tag.kind === "performer" && !tag.private && total > 0 && (
                    <CompanionsSection tagId={tag.id} seed={seed} />
                )}

                {total === 0 && (
                    <Text size="sm" c="dimmed">
                        Nothing you can see carries this tag right now.
                    </Text>
                )}
            </Stack>
        </Box>
    );
};
