import { redirect } from "next/navigation";
import { ORGANIZATIONS_PATH } from "@/lib/routes";

// `/project` names no project: the organizations, whose pages list them.
export default function ProjectRoot() {
  redirect(ORGANIZATIONS_PATH);
}
