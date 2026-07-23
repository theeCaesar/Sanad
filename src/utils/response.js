const sendOk = (res, data = null, message = 'OK', meta = undefined) => {
  const body = { status: 'success', message, data };
  if (meta) body.meta = meta;
  return res.status(200).json(body);
};

const sendCreated = (res, data = null, message = 'Created') =>
  res.status(201).json({ status: 'success', message, data });

const sendNoContent = (res) => res.status(204).send();

const sendPaginated = (res, items, { page, limit, total }, message = 'OK') =>
  res.status(200).json({
    status: 'success',
    message,
    data: items,
    meta: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1,
      hasNext: page * limit < total,
    },
  });

module.exports = { sendOk, sendCreated, sendNoContent, sendPaginated };
