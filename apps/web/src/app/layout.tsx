import type { Metadata } from "next";
import { AuthProvider } from "@/components/providers/AuthProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";
import { ToastProvider } from "@/hooks/useToast";
import { ConfirmProvider } from "@/hooks/useConfirm";
import "./globals.css";

export const metadata: Metadata = {
  title: "APILens - API Monitoring Dashboard",
  description: "Monitor your API performance and health",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body className="antialiased">
        <AuthProvider>
          <ThemeProvider>
            <ToastProvider>
              <ConfirmProvider>
                {children}
              </ConfirmProvider>
            </ToastProvider>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
