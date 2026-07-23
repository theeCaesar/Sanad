

const AppError = require('../utils/appError');

const SAGA_STATE = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  COMPENSATING: 'compensating',
  COMPENSATED: 'compensated',
  FAILED: 'failed',
});

function createSagaOrchestrator(deps) {
  const { db, sagaRepo, logger, metrics = null, now = () => new Date() } = deps;

  async function run(def, ctx, input) {
    const saga = await sagaRepo.create({
      org_id: ctx.orgId,
      type: def.type,
      correlation_id: ctx.correlationId,
      context: input,
    });

    logger.info({ sagaId: saga.id, type: def.type }, 'saga: started');

    const completed = [];

    for (const step of def.steps) {
      try {
        await sagaRepo.setCurrentStep(saga.id, step.name);

        const result = await step.invoke(input, { sagaId: saga.id, ...ctx });

        if (result && typeof result === 'object') {
          Object.assign(input, result);
          await sagaRepo.mergeContext(saga.id, result);
        }

        completed.push(step.name);
        await sagaRepo.markStepCompleted(saga.id, step.name);

        logger.info({ sagaId: saga.id, step: step.name }, 'saga: step ok');
      } catch (err) {
        logger.error(
          { sagaId: saga.id, step: step.name, err: err.message },
          'saga: step FAILED — compensating'
        );
        metrics?.sagaCompensated?.inc({ type: def.type, failed_step: step.name });

        await compensate(def, saga.id, completed, input, ctx, err);

        throw new AppError(
          `Could not complete: ${step.name} failed (${err.message}). ` +
          `Everything already done has been rolled back.`,
          409,
          { code: 'SAGA_COMPENSATED', details: { failed_step: step.name }, retryable: true }
        );
      }
    }

    await sagaRepo.setState(saga.id, SAGA_STATE.COMPLETED);
    metrics?.sagaCompleted?.inc({ type: def.type });
    logger.info({ sagaId: saga.id, steps: completed.length }, 'saga: completed');

    return { sagaId: saga.id, state: SAGA_STATE.COMPLETED, context: input };
  }

  async function compensate(def, sagaId, completed, input, ctx, originalError) {
    await sagaRepo.setState(sagaId, SAGA_STATE.COMPENSATING, String(originalError.message));

    const byName = new Map(def.steps.map((s) => [s.name, s]));

    for (const name of [...completed].reverse()) {
      const step = byName.get(name);
      if (!step?.compensate) {
        logger.warn({ sagaId, step: name }, 'saga: step has no compensation — skipping');
        continue;
      }

      try {
        await step.compensate(input, { sagaId, ...ctx });
        await sagaRepo.markStepCompensated(sagaId, name);
        logger.info({ sagaId, step: name }, 'saga: compensated');
      } catch (compErr) {
        logger.fatal(
          { sagaId, step: name, err: compErr.message, originalError: originalError.message },
          'saga: COMPENSATION FAILED — manual intervention required'
        );
        await sagaRepo.setState(
          sagaId,
          SAGA_STATE.FAILED,
          `Compensation of "${name}" failed: ${compErr.message}. ` +
          `Original failure: ${originalError.message}. MANUAL INTERVENTION REQUIRED.`
        );
        return;
      }
    }

    await sagaRepo.setState(sagaId, SAGA_STATE.COMPENSATED);
    logger.info({ sagaId }, 'saga: fully compensated — system consistent');
  }

  async function recoverStuck(def, { olderThanMs = 60_000 } = {}) {
    const stuck = await sagaRepo.findStuck(def.type, olderThanMs);

    for (const s of stuck) {
      logger.warn(
        { sagaId: s.id, completed: s.completed_steps, currentStep: s.current_step },
        'saga: recovering a saga stranded by a crash'
      );
      await compensate(
        def, s.id, s.completed_steps, s.context,
        { orgId: s.org_id, correlationId: s.correlation_id },
        new Error('Process crashed mid-saga; recovered by sweep')
      );
    }
    return stuck.length;
  }

  return { run, compensate, recoverStuck, SAGA_STATE };
}

function visitCompleteSaga({ orderService, paymentGateway, logisticsPartner, notifier, logger }) {
  return {
    type: 'visit.complete',
    steps: [
      {
        name: 'create_order',
        invoke: async (input, ctx) => {
          const order = await orderService.createFromVisit({
            orgId: ctx.orgId,
            visitId: input.visit_id,
            lines: input.lines,
            userId: input.user_id,
            mutationId: ctx.correlationId,
          });
          return { order_id: order.id, total: order.total };
        },
        compensate: async (input, ctx) => {
          await orderService.voidOrder({
            orgId: ctx.orgId,
            orderId: input.order_id,
            reason: 'saga compensation',
          });
        },
      },

      {
        name: 'charge_account',
        invoke: async (input, ctx) => {
          const charge = await paymentGateway.charge({
            customerId: input.customer_id,
            amount: input.total,
            idempotencyKey: `${ctx.correlationId}:charge`,
          });
          return { charge_id: charge.id };
        },
        compensate: async (input, ctx) => {
          if (!input.charge_id) return;
          await paymentGateway.refund({
            chargeId: input.charge_id,
            idempotencyKey: `${ctx.correlationId}:refund`,
          });
        },
      },

      {
        name: 'schedule_restock',
        invoke: async (input, ctx) => {
          const booking = await logisticsPartner.book({
            userId: input.user_id,
            items: input.lines,
            idempotencyKey: `${ctx.correlationId}:restock`,
          });
          return { booking_id: booking.id };
        },
        compensate: async (input) => {
          if (!input.booking_id) return;
          await logisticsPartner.cancel(input.booking_id);
        },
      },

      {
        name: 'notify_customer',
        invoke: async (input, ctx) => {
          await notifier.send({
            orgId: ctx.orgId,
            customerId: input.customer_id,
            key: 'ORDER_CREATED',
            params: { total: input.total },
          });
          return {};
        },
      },
    ],
  };
}

module.exports = { createSagaOrchestrator, visitCompleteSaga, SAGA_STATE };
