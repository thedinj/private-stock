"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { domainKinds, roomsSchema, type DomainKind, type RoomSwitch } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { useAuth } from "@/lib/api/AuthProvider";

/**
 * The rooms that are on (§21 "Turning a room off").
 *
 * Read once per page load, before the tab settles in a room (`RoomCheck`), and held: a room
 * turned off while a tab is in it is left on the next load, the way changing room is a reload.
 * Parsed rather than trusted, because which room a tab opens in follows from it.
 */
export const useRooms = () => {
    const { user } = useAuth();

    return useQuery({
        queryKey: queryKeys.rooms(),
        queryFn: async () => roomsSchema.parse(await api<unknown>("/api/rooms")),
        enabled: user !== null,
        staleTime: Infinity,
    });
};

/** The rooms on, or every room until the server has said otherwise. */
export const useEnabledRooms = (): readonly DomainKind[] => useRooms().data?.enabled ?? domainKinds;

/** Turn one room on or off (Libraries › Rooms). The answer is the whole list, so it is written. */
export const useSwitchRoom = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: RoomSwitch) =>
            api<unknown>("/api/rooms", { method: "PUT", body: JSON.stringify(input) }).then(
                (data) => roomsSchema.parse(data)
            ),
        onSuccess: (rooms) => {
            queryClient.setQueryData(queryKeys.rooms(), rooms);
        },
    });
};
