import { redirect } from "next/navigation";

/** The automation console moved behind its own ID + password at /automation. */
export default function XflowMoved() {
  redirect("/automation");
}
