import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage from './page';

interface MutationOptions<T> {
  onSuccess?: (data: T) => void;
  onError?: (err: { message: string }) => void;
}

const mocks = vi.hoisted(() => ({
  auth: { isAuthenticated: false, isLoading: false, login: vi.fn() },
  search: new URLSearchParams(),
  push: vi.fn(),
  loginMutate: vi.fn(),
  publicMutate: vi.fn(),
  loginOptions: {} as MutationOptions<{ token: string }>,
  publicOptions: {} as MutationOptions<{ url: string }>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => mocks.search,
}));

vi.mock('@/lib/auth-context', () => ({ useAuth: () => mocks.auth }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    auth: {
      login: {
        useMutation: (options: MutationOptions<{ token: string }>) => {
          mocks.loginOptions = options;
          return { mutate: mocks.loginMutate, isPending: false };
        },
      },
      createPublicLoginUrl: {
        useMutation: (options: MutationOptions<{ url: string }>) => {
          mocks.publicOptions = options;
          return { mutate: mocks.publicMutate };
        },
      },
    },
  },
}));

const NEXT = '/123e4567-e89b-42d3-a456-426614174000/a.html';

async function signIn() {
  await userEvent.type(screen.getByLabelText('Password'), 'pw');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(mocks.loginMutate).toHaveBeenCalledWith({ password: 'pw' });
  mocks.loginOptions.onSuccess?.({ token: 'new' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.isAuthenticated = false;
  mocks.auth.isLoading = false;
  mocks.search = new URLSearchParams();
});

describe('LoginPage', () => {
  it('goes home after signing in', async () => {
    render(<LoginPage />);
    await signIn();
    expect(mocks.auth.login).toHaveBeenCalledWith('new');
    expect(mocks.push).toHaveBeenCalledWith('/');
  });

  it('goes back to the public file after signing in', async () => {
    mocks.search = new URLSearchParams({ public: NEXT });
    render(<LoginPage />);
    await signIn();
    expect(mocks.publicMutate).toHaveBeenCalledWith({ next: NEXT });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('goes back to the public file at once when already signed in', () => {
    mocks.search = new URLSearchParams({ public: NEXT });
    mocks.auth.isAuthenticated = true;
    render(<LoginPage />);
    expect(mocks.publicMutate).toHaveBeenCalledTimes(1);
  });

  it('still goes back after signing in when the stored token was stale', async () => {
    mocks.search = new URLSearchParams({ public: NEXT });
    mocks.auth.isAuthenticated = true;
    render(<LoginPage />);
    expect(mocks.publicMutate).toHaveBeenCalledTimes(1);
    mocks.publicOptions.onError?.({ message: 'UNAUTHORIZED' });

    await signIn();
    expect(mocks.publicMutate).toHaveBeenCalledTimes(2);
  });
});
