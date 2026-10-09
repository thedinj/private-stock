"use client";

import { useEffect, useState } from "react";
import { Loader, VisuallyHidden } from "@mantine/core";

import { Burst } from "./Burst";
import classes from "./StageFlash.module.scss";

/**
 * Word over the picture that a rating or a favourite was stored (§14b).
 *
 * Shown for every one, clicked or pressed. It began with the keys: the number pad rates and
 * `h` favourites, and both are pressed by somebody looking at the film — often in fullscreen, often with the title row and its stars scrolled out of sight.
 * The stars changing was the only acknowledgement, which from the picture is no
 * acknowledgement at all: pressing 4 and seeing nothing happen reads as a missed key, and
 * pressing it again clears the rating.
 *
 * So the answer appears where the eyes already are, the way a player shows its volume, and
 * leaves. **It says what was stored, not what was pressed**: shown at once, confirmed with a
 * tick when the server answers, and replaced by a failure if it does not — a message that only
 * echoed the keystroke would say "rated" about a write that never landed.
 *
 * Deliberately not a toast. A corner is the one place nobody watching a film is looking, and
 * rating by feel — 3, no, 4 — would stack a column of them.
 *
 * **Five stars and a new favourite are made a fuss of.** Bigger, lit, the stars arriving one
 * after another and a spray of them (or of hearts) behind. They are the verdicts somebody would
 * say out loud; a four and an un-favourite are recorded as quietly as everything else.
 */

export type StageFlashState = "pending" | "saved" | "failed";

export type StageFlashMessage = {
    /** A new one per keypress, so a repeat of the same value is still a new message. */
    key: number;
    state: StageFlashState;
} & (
    | {
          subject: "rating";
          rating: number | null;
          /** Said beside five stars. Chosen with the press -- see `pickAccolade`. */
          accolade: string;
      }
    | { subject: "favorite"; favorite: boolean }
    /**
     * A key that could not do what it names, and why -- `Delete` on an item in a read-only
     * library. Always `failed`: it is shown for as long as a failure, with no tick, because a
     * key that silently does nothing reads as a broken key.
     */
    | { subject: "refused"; text: string }
);

const ACCOLADES = ["Chef's kiss", "Masterpiece", "Top shelf", "Bravo"];

/**
 * A different word for five stars each time.
 *
 * The same praise for the fortieth five-star item reads as a label, not a reaction. Chosen by
 * whoever creates the message, in the event handler rather than here during render, so that
 * the confirmation arriving -- which re-renders the same message -- cannot swap the word
 * while it is on screen.
 */
export const pickAccolade = (): string =>
    ACCOLADES[Math.floor(Math.random() * ACCOLADES.length)] ?? "Top shelf";

/** Long enough to read five stars; short enough to be gone before the next scene matters. */
const SHOWN_MS = 1_100;
/** A failure is worth longer, because it asks you to do something. */
const FAILED_MS = 3_000;
/** The celebration gets time to finish landing before it leaves. */
const GRAND_MS = 2_000;

/** Five stars, or a heart given rather than taken back -- and only once it is not a failure. */
export const isGrand = (message: StageFlashMessage): boolean =>
    message.state !== "failed" &&
    ((message.subject === "rating" && message.rating === 5) ||
        (message.subject === "favorite" && message.favorite));

const STARS = [1, 2, 3, 4, 5];

/** What it says aloud: the same message for anybody not looking at the picture. */
const spoken = (message: StageFlashMessage): string => {
    if (message.subject === "refused") return message.text;

    if (message.subject === "rating") {
        if (message.state === "failed") return "Could not save your rating.";
        if (message.rating === null) return "Rating cleared.";
        return `Rated ${message.rating} ${message.rating === 1 ? "star" : "stars"}.`;
    }

    if (message.state === "failed") return "Could not save your favourite.";
    return message.favorite ? "Added to favourites." : "Removed from favourites.";
};

const Body: React.FC<{ message: StageFlashMessage }> = ({ message }) => {
    if (message.state === "failed" || message.subject === "refused") {
        return <span className={classes.failed}>{spoken(message)}</span>;
    }

    if (message.subject === "favorite") {
        return (
            <>
                <span className={classes.heart} data-on={message.favorite || undefined}>
                    {message.favorite ? "♥" : "♡"}
                </span>
                <span>{message.favorite ? "Favourite!" : "Not a favourite"}</span>
            </>
        );
    }

    return (
        <>
            <span className={classes.stars}>
                {STARS.map((star) => (
                    <span
                        key={star}
                        data-on={(message.rating !== null && star <= message.rating) || undefined}
                    >
                        ★
                    </span>
                ))}
            </span>
            {message.rating === null && <span>Rating cleared</span>}
            {message.rating === 5 && <span className={classes.accolade}>{message.accolade}</span>}
        </>
    );
};

export const StageFlash: React.FC<{ message: StageFlashMessage | null }> = ({ message }) => {
    /**
     * Which message has had its time, rather than a `visible` flag.
     *
     * A flag set on arrival and cleared by a timer races the next keypress: press 3 then 4
     * inside a second and the first timer hides the second message early. Hiding *this* key
     * in *this* state can only ever hide the thing it was started for.
     */
    const [spent, setSpent] = useState<string | null>(null);
    const tag = message ? `${message.key}:${message.state}` : null;

    useEffect(() => {
        // Held for as long as the answer is outstanding: fading out before the server has
        // spoken would be the keystroke-echo this exists not to be.
        if (!message || message.state === "pending") return;

        const timer = setTimeout(
            () => setSpent(tag),
            message.state === "failed" ? FAILED_MS : isGrand(message) ? GRAND_MS : SHOWN_MS
        );

        return () => clearTimeout(timer);
    }, [message, tag]);

    const visible = !!message && spent !== tag;
    const grand = !!message && isGrand(message);

    return (
        <>
            <div
                className={classes.flash}
                data-visible={visible || undefined}
                data-grand={grand || undefined}
                aria-hidden
            >
                {message && (
                    <>
                        {/* Keyed by the press, so each one sprays again. Not re-fired by the
                            same press being confirmed: the key does not change with state. */}
                        {grand && (
                            <Burst
                                key={message.key}
                                glyph={message.subject === "rating" ? "★" : "♥"}
                                reach="5.5rem"
                            />
                        )}
                        <Body message={message} />
                        {message.state === "pending" && (
                            <Loader size={12} color="gray.4" className={classes.status} />
                        )}
                        {message.state === "saved" && <span className={classes.status}>✓</span>}
                    </>
                )}
            </div>

            {/* Always mounted, so the text changing is what gets read out. */}
            <VisuallyHidden role="status" aria-live="polite">
                {message && message.state !== "pending" ? spoken(message) : ""}
            </VisuallyHidden>
        </>
    );
};
