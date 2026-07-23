import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryCache, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme";
import { Layout } from "@/components/layout";
import { Spinner } from "@/components/ui/spinner";

// Eagerly load the shell pages (always needed on first paint or tiny)
import Home from "./pages/home";
import NotFound from "@/pages/not-found";

// Lazy-load every other route — keeps the initial bundle small
const Browse = lazy(() => import("./pages/browse"));
const Leaderboard = lazy(() => import("./pages/leaderboard"));
const AccountDetail = lazy(() => import("./pages/account-detail"));
const Profile = lazy(() => import("./pages/profile"));
const Submit = lazy(() => import("./pages/submit"));
const Admin = lazy(() => import("./pages/admin"));
const Earn = lazy(() => import("./pages/earn"));
const Login = lazy(() => import("./pages/login"));
const Register = lazy(() => import("./pages/register"));
const Giveaways = lazy(() => import("./pages/giveaways"));
const ForgotPassword = lazy(() => import("./pages/forgot-password"));
const ResetPassword = lazy(() => import("./pages/reset-password"));
const Banned = lazy(() => import("./pages/banned"));
const Messages = lazy(() => import("./pages/messages"));
const EditProfile = lazy(() => import("./pages/edit-profile"));
const Store = lazy(() => import("./pages/store"));
const ProductDetail = lazy(() => import("./pages/product-detail"));
const Premium = lazy(() => import("./pages/premium"));

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      const status = (error as any)?.status;
      if (typeof status === "number" && status >= 400 && status < 500) return;
      console.error(error);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 60_000,           // treat cached data as fresh for 1 min — prevents refetch on every mount/focus
      refetchOnWindowFocus: false, // don't refetch on tab-switch — saves Vercel function invocations
      retry: (failureCount, error) => {
        const status = (error as any)?.status;
        if (typeof status === "number" && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      throwOnError: false,
    },
    mutations: {
      throwOnError: false,
    },
  },
});

function ScrollToTop() {
  const [location] = useLocation();
  const isPopState = useRef(false);

  // Intercept pushState once so we capture the scroll position AT the moment
  // the user navigates away — more reliable than a debounced scroll listener.
  useEffect(() => {
    history.scrollRestoration = "manual";

    const orig = history.pushState.bind(history);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (history as any).pushState = function (state: any, title: string, url?: string | URL | null) {
      sessionStorage.setItem(`scroll:${window.location.pathname}`, String(window.scrollY));
      return orig(state, title, url);
    };

    const onPop = () => { isPopState.current = true; };
    window.addEventListener("popstate", onPop);

    return () => {
      (history as any).pushState = orig;
      window.removeEventListener("popstate", onPop);
      history.scrollRestoration = "auto";
    };
  }, []); // intentionally run once

  // On route change: restore scroll for back/forward, or jump to top for fresh nav.
  // /browse handles its own restoration after data finishes loading.
  const DATA_RESTORE_PATHS = ["/browse"];
  useEffect(() => {
    if (isPopState.current) {
      isPopState.current = false;
      if (DATA_RESTORE_PATHS.includes(location)) return;
      const saved = Number(sessionStorage.getItem(`scroll:${location}`) ?? 0);
      requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, saved)));
      return;
    }
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [location]);

  return null;
}

function BannedGuard({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: user } = useQuery({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    retry: false,
    staleTime: 5 * 60_000,
  });

  // If banned and not already on the banned page, redirect there
  if (user?.isBanned && location !== "/banned") {
    window.location.replace("/banned");
  }
  return <>{children}</>;
}

function PageLoader() {
  return (
    <Layout>
      <div className="flex items-center justify-center min-h-[60vh]">
        <Spinner className="size-8 text-primary" />
      </div>
    </Layout>
  );
}

function Router() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/browse" component={Browse} />
        <Route path="/leaderboard" component={Leaderboard} />
        <Route path="/accounts/:id" component={AccountDetail} />
        <Route path="/profile/:id" component={Profile} />
        <Route path="/submit" component={Submit} />
        <Route path="/admin" component={Admin} />
        <Route path="/earn" component={Earn} />
        <Route path="/login" component={Login} />
        <Route path="/register" component={Register} />
        <Route path="/giveaways" component={Giveaways} />
        <Route path="/forgot-password" component={ForgotPassword} />
        <Route path="/reset-password" component={ResetPassword} />
        <Route path="/banned" component={Banned} />
        <Route path="/store" component={Store} />
        <Route path="/store/:id" component={ProductDetail} />
        <Route path="/messages" component={Messages} />
        <Route path="/edit-profile" component={EditProfile} />
        <Route path="/premium" component={Premium} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base="">
            <BannedGuard>
              <ScrollToTop />
              <Router />
            </BannedGuard>
          </WouterRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
