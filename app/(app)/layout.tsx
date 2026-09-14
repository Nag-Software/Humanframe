import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { AppSidebar } from "@/components/app-sidebar";
import { I18nProvider } from "@/components/i18n-provider";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { getDictionary, getLocale } from "@/lib/i18n";
import { requireRequestScope } from "@/server/db/request-scope";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const scope = await requireRequestScope();
  const dictionary = getDictionary(await getLocale());

  return (
    <I18nProvider dictionary={dictionary}>
      <SidebarProvider>
        <AppSidebar
          user={{
            name: scope.userName ?? scope.email ?? "",
            email: scope.email ?? "",
            avatar: "",
          }}
          plan={scope.workspace.plan}
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
    </I18nProvider>
  );
}
