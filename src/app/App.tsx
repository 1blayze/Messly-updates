import "../styles/base/app.css";
import { AuthProvider } from "../auth/AuthProvider";
import AppRoutes from "../router/routes";
import MesslyRuntimeBootstrap from "./MesslyRuntimeBootstrap";
import { TooltipProvider } from "../components/ui/Tooltip";

export default function App() {
  return (
    <AuthProvider>
      <TooltipProvider>
        <MesslyRuntimeBootstrap />
        <AppRoutes />
      </TooltipProvider>
    </AuthProvider>
  );
}
