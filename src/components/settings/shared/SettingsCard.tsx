import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';

interface SettingsCardProps {
  title: string;
  description: ReactNode;
  /** Replaces the content with a spinner, keeping the header stable while data loads. */
  isLoading?: boolean;
  children: ReactNode;
}

export function SettingsCard({
  title,
  description,
  isLoading = false,
  children,
}: SettingsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner size="lg" />
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
