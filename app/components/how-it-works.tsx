"use client";

import { Link as LinkIcon, MessageSquare, FileText } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="mx-auto max-w-6xl px-4 pb-24 sm:px-6 lg:px-8"
    >
      <div className="mb-12 text-center">
        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
          How it works
        </h2>
        <p className="mt-3 text-muted-foreground">
          Three steps to a safer dependency decision.
        </p>
      </div>
      <div className="grid gap-6 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <LinkIcon className="h-5 w-5" />
            </div>
            <CardTitle>1. Paste a URL</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Enter an npm package URL, a GitHub repo URL, or just a package
              name. We fetch the latest metadata.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <MessageSquare className="h-5 w-5" />
            </div>
            <CardTitle>2. Add a prompt</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Tell the AI what matters to you — security posture, license
              compatibility, maintenance health, or supply-chain risk.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileText className="h-5 w-5" />
            </div>
            <CardTitle>3. Get a report</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Receive a structured audit with a trust score, risk breakdown,
              dependency tree, and license analysis.
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
