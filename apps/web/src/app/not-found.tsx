import Link from "next/link";
import { Anchor, Button, Card, Center, Stack, Text, Title } from "@mantine/core";

/**
 * The 404 page.
 *
 * Worth defining explicitly rather than relying on Next's default. Without an App Router
 * `not-found`, a build that cannot prerender `/404` falls back to the Pages Router's
 * `_error`, which imports `<Html>` — surfacing as:
 *
 *     Error: <Html> should not be imported outside of pages/_document.
 *
 * That message points at a file this project does not have, so the real cause (a failed
 * prerender) stays hidden. Owning the route keeps the failure legible, and gives a 404 that
 * matches the rest of the app rather than an unstyled default.
 */
const NotFound: React.FC = () => (
    <Center mih="100dvh" px="md">
        <Card w="100%" maw={420} p="xl" radius="md">
            <Stack gap="md" align="center">
                <Title order={2}>Not found</Title>
                <Text size="sm" c="dimmed" ta="center">
                    That page or item does not exist — or it is in a library you do not have access
                    to.
                </Text>
                <Button component={Link} href="/" variant="light">
                    Back to the library
                </Button>
                <Anchor component={Link} href="/login" size="xs" c="dimmed">
                    Sign in
                </Anchor>
            </Stack>
        </Card>
    </Center>
);

export default NotFound;
