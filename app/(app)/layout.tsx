import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { loadNotificationSettings } from "@/lib/settings/notification-settings";
import { requireRequestScope } from "@/server/db/request-scope";
import { Analytics } from "@vercel/analytics/next";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const scope = await requireRequestScope();
  const notificationSettings = await loadNotificationSettings(scope);

  return (
    <>
      <Analytics />
      <SidebarProvider>
        <AppSidebar
          user={{
            name: scope.userName ?? scope.email ?? "",
            email: scope.email ?? "",
            avatar: "",
          }}
          plan={scope.workspace.plan}
          notificationSettings={notificationSettings}
        />
        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
            <div className="flex items-center gap-2 px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mr-2 data-vertical:h-4 data-vertical:self-auto"
              />
              <AppBreadcrumb />
            </div>
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </>
  );
}
