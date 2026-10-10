"use client";

import { useRef } from "react";
import { CloseButton, TextInput, type TextInputProps } from "@mantine/core";

/**
 * A text box for searching or filtering, with an × that empties it.
 *
 * Mantine's `TextInput` has no clear button of its own, and a filter you can only undo by
 * selecting the text and deleting it is a chore on a phone. The × appears only while there is
 * something to clear, and puts the cursor back in the box so the next search can be typed at once.
 */

interface SearchInputProps extends Omit<TextInputProps, "value" | "onChange" | "rightSection"> {
    value: string;
    onChange: (value: string) => void;
    /** Read aloud for the ×; defaults to "Clear the search". */
    clearLabel?: string;
}

export const SearchInput: React.FC<SearchInputProps> = ({
    value,
    onChange,
    clearLabel = "Clear the search",
    ...props
}) => {
    const inputRef = useRef<HTMLInputElement>(null);

    return (
        <TextInput
            {...props}
            ref={inputRef}
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            rightSection={
                value ? (
                    <CloseButton
                        aria-label={clearLabel}
                        // Keeps focus in the box rather than letting the button take it.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                            onChange("");
                            inputRef.current?.focus();
                        }}
                    />
                ) : null
            }
        />
    );
};
