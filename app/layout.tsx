import * as React from "react";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AuditJobsProvider } from "@/app/components/audit-jobs";
import { AuthProvider } from "@/app/lib/use-auth";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "sbomit — AI Audit for npm Libraries",
  description:
    "Upload or search npm packages and get an AI-powered security, license, and dependency audit in seconds.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AuthProvider>
          <AuditJobsProvider>{children}</AuditJobsProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
