import { useAppSelector } from "../stores/store";

export function useGateway() {
  return useAppSelector((state) => state.gateway);
}
