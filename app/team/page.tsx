"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AppShell, useMe } from "@/components/AppShell";
import { PlusIcon } from "@/components/icons";
import { Avatar, Badge, Button, Card, Field, inputStyles, Notice, PageHeader } from "@/components/ui";
import { api, ApiError, postJson } from "@/lib/client/api";

type Role = "admin" | "viewer";
type Member = { name: string; email: string; role: Role };
type Invite = { id: string; email: string; role: Role; invitedAt: number; status: "invited" };
type Team = { members: Member[]; invites: Invite[] };

const ROLE_LABEL = { admin: "Admin", viewer: "Viewer" } as const;

export default function TeamPage() {
  return (
    <AppShell>
      <TeamView />
    </AppShell>
  );
}

/**
 * Members and pending invites of the current organization. Admins can invite
 * (email + role) and cancel invites; viewers only see the list.
 */
function TeamView() {
  const me = useMe();
  const isAdmin = me?.role === "admin";
  const [team, setTeam] = useState<Team | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);

  useEffect(() => {
    api<Team>("/api/team").then(setTeam).catch(() => setMessage({ kind: "error", text: "Could not load your team." }));
  }, []);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setInviting(true);
    setMessage(null);
    setFieldErrors({});
    try {
      const { invite } = await postJson<{ invite: Invite }>("/api/team/invites", { email, role });
      setMessage({ kind: "success", text: `Invited ${invite.email} as ${ROLE_LABEL[invite.role]}.` });
      setEmail("");
      setTeam(await api<Team>("/api/team"));
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setMessage({ kind: "error", text: err.message });
      } else {
        setMessage({ kind: "error", text: "Could not send the invite." });
      }
    } finally {
      setInviting(false);
    }
  }

  async function cancel(inv: Invite) {
    setCancelling(inv.id);
    setMessage(null);
    try {
      await api(`/api/team/invites/${inv.id}`, { method: "DELETE" });
      setMessage({ kind: "success", text: `Cancelled the invite for ${inv.email}.` });
      setTeam(await api<Team>("/api/team"));
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Could not cancel the invite." });
    } finally {
      setCancelling(null);
    }
  }

  return (
    <>
      <PageHeader title="Team" description={<>People who can open {me?.tenant.name}. Admins can upload, analyse and invite; viewers can only look.</>} />

      {message && <Notice kind={message.kind} className="mb-6">{message.text}</Notice>}

      {isAdmin ? (
        <Card title="Invite a teammate" description="They are listed below as Invited. No email is sent in this demo.">
          <form onSubmit={invite} noValidate className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-start">
            <Field id="inviteEmail" label="Email address" type="email" placeholder="name@company.com" value={email}
              error={fieldErrors.email} onChange={(e) => setEmail(e.target.value)} />
            <div>
              <label htmlFor="inviteRole" className="mb-1.5 block text-sm font-medium text-ink-800">Role</label>
              <select id="inviteRole" value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputStyles}>
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <Button type="submit" loading={inviting} loadingText="Inviting…" icon={<PlusIcon className="size-4" />} className="sm:mt-7">
              Send invite
            </Button>
          </form>
        </Card>
      ) : (
        <Notice kind="info" className="mb-6">You have read-only access to {me?.tenant.name}. Only admins can invite people.</Notice>
      )}

      <Card title="Members" bodyClassName=""
        action={team ? <Badge>{team.members.length} {team.members.length === 1 ? "member" : "members"}</Badge> : undefined}>
        {team === null ? (
          <div className="space-y-3 p-5" aria-busy="true">
            <span className="sr-only">Loading members</span>
            {[0, 1].map((i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-ink-100" />)}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-ink-50 text-xs font-medium text-ink-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Name</th>
                  <th className="px-3 py-2.5 font-medium">Email</th>
                  <th className="px-3 py-2.5 font-medium">Role</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 text-right font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {team.members.map((m) => (
                  <tr key={m.email} className="transition-colors hover:bg-ink-50/70">
                    <td className="px-5 py-3">
                      <span className="flex items-center gap-3">
                        <Avatar name={m.name} size="sm" />
                        <span className="truncate font-medium text-ink-900">{m.name}</span>
                      </span>
                    </td>
                    <td className="px-3 py-3 text-ink-700">{m.email}</td>
                    <td className="px-3 py-3"><RoleBadge role={m.role} /></td>
                    <td className="px-3 py-3"><Badge tone="success">Active</Badge></td>
                    <td className="px-5 py-3" />
                  </tr>
                ))}
                {team.invites.map((i) => (
                  <tr key={i.id} className="transition-colors hover:bg-ink-50/70">
                    <td className="px-5 py-3 text-ink-500">Not joined yet</td>
                    <td className="px-3 py-3 text-ink-700">{i.email}</td>
                    <td className="px-3 py-3"><RoleBadge role={i.role} /></td>
                    <td className="px-3 py-3"><Badge tone="warning">Invited</Badge></td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end">
                        {isAdmin && (
                          <Button size="sm" variant="ghost" onClick={() => cancel(i)} loading={cancelling === i.id}
                            disabled={cancelling !== null} aria-label={`Cancel invite for ${i.email}`}
                            className="hover:bg-red-50 hover:text-red-600">
                            Cancel invite
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={role === "admin" ? "brand" : "neutral"}>{ROLE_LABEL[role]}</Badge>;
}
