import "server-only";
import { base32Decode } from "@/lib/server/totp";
import type { Job, JobOrigin, Project } from "../contract";
import type { JobRecord, ProjectRecord } from "./records";

/**
 * Rules about projects: what counts as a valid target, where a full QA run is
 * allowed, and what of a project or job a browser may see.
 */

/**
 * A target must be a plain http(s) address. Credentials inside the URL
 * (https://user:pass@host) are refused: the URL is passed to a child process
 * as an argument and shown on screen, and neither is a place for a password.
 *
 * Stored as origin plus path, without a trailing slash, query or fragment,
 * none of which mean anything for a deployment's base address.
 */
export function parseTargetUrl(input: string): { url: string; host: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { error: "Enter the target as a full address, for example https://staging.example.com." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "The target address must start with http:// or https://." };
  }
  if (url.username || url.password) {
    return { error: "Leave the sign-in details out of the address. Enter them in the QA account fields." };
  }
  return { url: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, host: url.hostname.toLowerCase() };
}

export function hostOf(targetUrl: string): string {
  return new URL(targetUrl).hostname.toLowerCase();
}

/**
 * Hostnames, without ports, from CONSOLE_QA_HOSTS. Read on every call so the
 * list is never stale.
 *
 * Unset means this machine only: localhost and 127.0.0.1. That is safe as a
 * default, because a QA run against your own machine can only touch your own
 * local stand-in. Any real server still has to be listed on purpose. Setting
 * the variable, even to an empty value, replaces the default entirely.
 */
const DEFAULT_QA_HOSTS = "localhost,127.0.0.1";

function qaHosts(): string[] {
  return (process.env.CONSOLE_QA_HOSTS ?? DEFAULT_QA_HOSTS)
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * A full QA run uploads and deletes data, so it may only run against a host
 * someone deliberately listed in CONSOLE_QA_HOSTS, or this machine when the
 * variable is unset. Explore is read-only and needs no such list.
 *
 * Returns null when allowed, otherwise the reason, word for word what the 403 says.
 */
export function qaRunRefusal(targetUrl: string): string | null {
  const host = hostOf(targetUrl);
  const allowed = qaHosts();
  if (allowed.includes(host)) return null;
  const list = allowed.length ? `The list is: ${allowed.join(", ")}.` : "CONSOLE_QA_HOSTS is empty, so no host is allowed.";
  return `A QA run uploads and deletes data, so it only runs against hosts listed in CONSOLE_QA_HOSTS. ${host} is not on that list. ${list}`;
}

/**
 * A TOTP secret as an authenticator app shows it: base32, often in groups.
 * Spaces and padding are dropped and letters upper-cased, then it must decode
 * (with the stand-in's own decoder) to at least 10 bytes, which is 16 base32
 * characters, the shortest secret authenticator apps commonly hand out.
 */
export function normalizeTotpSecret(input: string): string | null {
  const secret = input.replace(/[\s=]+/g, "").toUpperCase();
  try {
    return base32Decode(secret).length >= 10 ? secret : null;
  } catch {
    return null;
  }
}

/** What a browser may see of a project: never the credentials, only whether they are set. */
export function toProjectDto(project: ProjectRecord): Project {
  return {
    id: project.id,
    name: project.name,
    targetUrl: project.targetUrl,
    qaEmail: project.qaEmail,
    hasCredentials: project.qaPasswordEnc !== null && project.qaTotpSecretEnc !== null,
    qaRunAllowed: qaRunRefusal(project.targetUrl) === null,
    createdAt: project.createdAt,
    createdBy: project.createdBy,
  };
}

/**
 * Drops which server process owns the job. That is the console's business, not the page's.
 * Adds where the job came from (the contract's JobOrigin), merged into the Job.
 */
export function toJobDto(job: JobRecord): Job & JobOrigin {
  return {
    id: job.id,
    projectId: job.projectId,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdBy: job.createdBy,
    logTail: job.logTail,
    proposals: job.proposals,
    approvedProposalIds: job.approvedProposalIds,
    explorer: job.explorer ?? null,
    messages: job.messages ?? [],
    summary: job.summary ?? null,
    result: job.result,
    error: job.error,
    trigger: job.trigger,
    commit: job.commit,
  };
}
