import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type Step<Id extends string> = { readonly id: Id; readonly label: string };

/** Navigation position is not analysis completion; selecting a step never runs work. */
export function WorkflowStepper<Id extends string>({
  steps, activeStep, onSelect,
}: {
  readonly steps: readonly Step<Id>[];
  readonly activeStep: Id;
  readonly onSelect: (step: Id) => void;
}) {
  const currentIndex = steps.findIndex((step) => step.id === activeStep);
  const progress = steps.length === 0 ? 0 : Math.round(((Math.max(currentIndex, 0) + 1) / steps.length) * 100);

  return (
    <nav aria-label="작업 단계" className="workflow-nav">
      <Progress aria-label="현재 단계" value={progress} className="stepper-progress" />
      <ol className="stepper-list">
        {steps.map(({ id, label }, index) => (
          <li key={id} className="stepper-item">
            <Button
              type="button"
              variant={activeStep === id ? "secondary" : "ghost"}
              className="stepper-trigger"
              aria-current={activeStep === id ? "step" : undefined}
              onClick={() => onSelect(id)}
            >
              <span className="step-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <span className="step-label">{label}</span>
            </Button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
