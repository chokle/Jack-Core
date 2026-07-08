import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface UserTestingModalProps {
  open: boolean;
  onStart: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}

/**
 * Consent gate for beta user-testing screen recording. Copy is exact —
 * do not paraphrase. No browser permission APIs are called until the user
 * clicks "Start Test" here.
 */
export function UserTestingModal({
  open,
  onStart,
  onCancel,
  cancelLabel = "Cancel",
}: UserTestingModalProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent data-testid="user-testing-modal">
        <AlertDialogHeader>
          <AlertDialogTitle>Help Us Improve Torch</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-left">
              <p>Thanks for helping test Torch.</p>
              <p>
                To better understand how people naturally use Torch, we'd like
                permission to record your screen during this session.
              </p>
              <p>
                If you agree, we'll record your screen (and optionally your
                microphone) until you finish testing.
              </p>
              <p>
                You're not being tested.
                <br />
                Torch is.
              </p>
              <p>Please think out loud while using the app.</p>
              <p>There are no wrong answers.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="user-testing-cancel" onClick={onCancel}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction data-testid="user-testing-start" onClick={onStart}>
            Start Test
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
