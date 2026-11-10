---
title: Managing people
part: admin
section: people
order: 1
audience: admin
summary: Invite people, set their role, and remove access, from Settings → People.
sources: [apps/web/src/ui/pages/settings/People.tsx, apps/web/src/ui/pages/settings/InviteModal.tsx, apps/web/src/api/routes/members.ts, apps/web/src/api/routes/invitations.ts]
verified: "0000000"
---

# Managing people

Admins decide who is in the organisation and what each person can do. Everything happens on
**Settings → People**: the members, their roles, and the invitations nobody has accepted yet.

## How it works

- **A role** decides what a person can do. A **member** uses the app; an **admin** also manages
  people and settings; an **owner** can also manage other owners.
- **An invitation** is for one email address and one role. It expires after
  {{fact:invitation.expiry_days}} days.
- **Removing a member** takes their access away at once. Their work stays in the organisation.

## Do it

To invite people:

1. Open **Settings → People** and choose **Invite**.
2. Pick **One person** and enter an email address, or **Several** and paste up to
   {{fact:invite.bulk_max}} addresses.
3. Choose the **Role** and send. The invitations appear under **Pending invitations**.

From **Pending invitations** you can **Resend** an invitation, **Copy link** to share it yourself,
or **Revoke** it.

To change a role, pick a new one beside the member. To take someone's access away, choose
**Remove** and confirm.

> **NOTE** — Only an owner can make someone an owner, and nobody can change their own role or
> remove themselves.

## Watch out for

- **A role you cannot change.** People managed by your identity provider show their role as
  locked. Change it there.
- **An owner cannot be removed here.** Make them an admin first, or ask another owner.
