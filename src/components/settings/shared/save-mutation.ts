/**
 * The slice of a React Query mutation result that edit-in-place settings fields need.
 * Pass the tRPC `useMutation` result directly; React Query resets `error` on the next
 * `mutate`, so components never track error text themselves.
 */
export interface SaveMutation {
  isPending: boolean;
  error: { message: string } | null;
  reset: () => void;
}
