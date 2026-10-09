import { Center, Loader } from "@mantine/core";

/**
 * A page's content on its way (§14, "house rules").
 *
 * Centred and brass, and rendered *below* the page's plate rather than instead of it: some
 * pages returned a bare spinner in the top-left corner and others replaced the whole page with
 * one, so the heading blinked in once the data arrived.
 */
export const PageLoader: React.FC = () => (
    <Center h={200}>
        <Loader color="brass" />
    </Center>
);
