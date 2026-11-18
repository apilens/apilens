"use client";

import { createContext, useContext } from "react";

/** The project's open incident count the app shell already fetched (#610), for menus under it. */
export const OpenIncidentsContext = createContext(0);

/** The open incident count of the project in scope; 0 outside a project shell. */
export function useShellOpenIncidents(): number {
  return useContext(OpenIncidentsContext);
}
